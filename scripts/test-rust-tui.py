#!/usr/bin/env python3
"""Black-box acceptance of the Rust binary; only generated test files are used."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import queue
import select
import signal
import struct
import subprocess
import tempfile
import termios
import threading
import time


class Node:
    def __init__(self, binary, data, report):
        self.stderr = open(report, 'ab')
        self.process = subprocess.Popen([str(binary), '--json', '--data-dir', str(data)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr, text=True, bufsize=1)
        self.responses = queue.Queue()
        self.sequence = 0
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()

    def read(self):
        for line in self.process.stdout:
            self.responses.put(line)
        self.responses.put(None)

    def raw(self, value):
        self.process.stdin.write(value + '\n')
        self.process.stdin.flush()
        response = self.responses.get(timeout=30)
        assert response is not None, 'Node stopped unexpectedly'
        return json.loads(response)

    def call(self, method, **params):
        self.sequence += 1
        response = self.raw(json.dumps({'id': self.sequence, 'method': method, 'params': params}))
        assert response['id'] == self.sequence and response['ok'], response
        return response['value']

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                assert self.process.wait(timeout=15) == 0
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
                raise
        self.reader.join(timeout=2)
        self.process.stdout.close()
        self.stderr.close()


def wait_state(node, group, predicate):
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        state = node.call('get_state', groupId=group)
        if predicate(state):
            return state
        time.sleep(0.15)
    raise AssertionError('Timed out waiting for synchronized state')


def terminal_test(binary, work, report):
    data = work / 'terminal-data'
    source = work / '终端 有空格.txt'
    source.write_text('terminal draft confirmation\n')
    transcript = bytearray()
    default_directory = work / '默认 下载'

    def session(action):
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 26, 100, 0, 0))
        original = termios.tcgetattr(slave)
        def controlling_terminal():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        process = subprocess.Popen([str(binary), '--data-dir', str(data)], stdin=slave, stdout=slave, stderr=slave, cwd=work, preexec_fn=controlling_terminal)
        observed = bytearray()
        def read_until(expected, timeout=20, reuse=False):
            if reuse and expected in observed.decode('utf-8', errors='replace'):
                return observed.decode('utf-8', errors='replace')
            current = bytearray()
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if select.select([master], [], [], 0.1)[0]:
                    chunk = os.read(master, 65536)
                    transcript.extend(chunk)
                    observed.extend(chunk)
                    current.extend(chunk)
                    if expected in current.decode('utf-8', errors='replace'):
                        return current.decode('utf-8', errors='replace')
                assert process.poll() is None, 'TUI exited before expected output'
            raise AssertionError('TUI output missing: ' + expected)
        def command(value, expected):
            os.write(master, ('\x1b[200~' + value + '\x1b[201~\r').encode())
            return read_until(expected)
        try:
            read_until('拾传')
            action(process, master, command, read_until)
            assert process.wait(timeout=15) == 0
            restored = termios.tcgetattr(slave)
            assert restored[3] & (termios.ECHO | termios.ICANON) == original[3] & (termios.ECHO | termios.ICANON), 'Raw mode was not restored'
        finally:
            report.write_bytes(transcript)
            if process.poll() is None:
                process.kill()
            os.close(master)
            os.close(slave)
            if process.poll() is None:
                process.wait(timeout=5)

    def keys(master, read_until, value, expected):
        os.write(master, value)
        return read_until(expected)

    def paste(master, value):
        os.write(master, ('\x1b[200~' + value + '\x1b[201~\r').encode())

    def menu(master, read_until, index, expected):
        # Return from detail/content, then select a menu without relying on old focus.
        keys(master, read_until, b'\x1b[D\x1b[D\x1b[H' + b'\x1b[B' * index + b'\x1b[C', expected)

    def first(process, master, command, read_until):
        # Real keyboard navigation creates the group; no slash command needed.
        menu(master, read_until, 1, '[新建传输群]')
        keys(master, read_until, b'\r', '输入新群名称')
        paste(master, 'TUI-验收')
        read_until('操作完成')
        menu(master, read_until, 2, '[输入文件路径]')
        keys(master, read_until, b'\r', '输入普通文件完整路径')
        paste(master, str(source))
        read_until('附件已暂存')
        snapshot = json.loads(next(data.glob('group_*.json')).read_text())
        assert len(snapshot['events']) == 0, 'Staging sent a file without confirmation'
        # Confirm dialog defaults to cancel: Enter alone must never send.
        keys(master, read_until, b'\r', '发送附件到群')
        keys(master, read_until, b'\r', '[发送 / 重试]')
        snapshot = json.loads(next(data.glob('group_*.json')).read_text())
        assert len(snapshot['events']) == 0, 'Default dialog choice sent the draft'
        # Create a second group through the menu and switch by stable ID.
        menu(master, read_until, 1, '[新建传输群]')
        keys(master, read_until, b'\r', '输入新群名称')
        paste(master, 'TUI-另一群')
        read_until('操作完成')
        group = json.loads((data / 'tui-drafts.json').read_text())[0]['group']
        command('/use ' + group, '操作完成')
        command('/help', '群聊中按 i')
        # Tab now changes panel focus, rather than accidentally changing groups.
        frame = keys(master, read_until, b'\t', '焦点：菜单')
        assert '群聊中按 i' not in frame, 'Tab retained old detail content'
        assert json.loads((data / 'tui-drafts.json').read_text())[0]['group'] == group
        # Message composition/editing remains Unicode-safe, Enter sends once.
        menu(master, read_until, 0, '[发送文字]')
        keys(master, read_until, b'i', '输入文字')
        paste(master, '键盘消息中文')
        read_until('操作完成')
        default_directory.mkdir()
        menu(master, read_until, 8, '[默认保存目录]')
        keys(master, read_until, b'\r', '输入默认保存目录')
        os.write(master, b'\x15')  # Ctrl+U clears the prefilled directory.
        paste(master, str(default_directory))
        read_until('默认保存目录已更新')
        preferences = json.loads((data / 'tui-preferences.json').read_text())
        assert preferences['downloadDirectory'] == str(default_directory)
        os.write(master, b'\x03')
    session(first)

    def second(process, master, command, read_until):
        read_until('终端 有空格.txt', reuse=True)
        group = json.loads((data / 'tui-drafts.json').read_text())[0]['group']
        menu(master, read_until, 7, '[发送 / 重试]')
        # Select send (cancel transfer is the first row), then explicitly choose confirm.
        keys(master, read_until, b'\x1b[B\r', '发送附件到群')
        keys(master, read_until, b'\x1b[C\r', '操作完成')
        snapshot = json.loads((data / ('group_' + group + '.json')).read_text())
        assert len(snapshot['events']) == 2
        assert json.loads((data / 'tui-drafts.json').read_text()) == []
        menu(master, read_until, 3, '终端 有空格.txt')
        keys(master, read_until, b'\r', '默认 下载')
        saved = default_directory / source.name
        keys(master, read_until, b'\r', '已校验并保存')
        assert saved.read_bytes() == source.read_bytes()
        # Directory list: path action, parent, two directories, source.
        menu(master, read_until, 2, '[输入文件路径]')
        keys(master, read_until, b'\x1b[B' * 4 + b'\r', '附件已暂存')
        assert json.loads((data / 'tui-drafts.json').read_text())[0]['path'] == str(source)
        assert len(json.loads((data / ('group_' + group + '.json')).read_text())['events']) == 2
        for rows, columns, expected in [(20, 60, '单栏'), (24, 80, '双栏'), (12, 36, '单栏'), (8, 24, '终端至少需要'), (40, 120, '双栏')]:
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
            os.kill(process.pid, signal.SIGWINCH)
            read_until(expected)
        # Narrow mode keeps both menu and content reachable with the same arrows.
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 20, 60, 0, 0))
        os.kill(process.pid, signal.SIGWINCH)
        read_until('单栏')
        menu(master, read_until, 8, '[修改设备名称]')
        keys(master, read_until, b'\x1b[B\r', '输入设备名称')
        paste(master, '键盘验收设备')
        read_until('操作完成')
        process.send_signal(signal.SIGTERM)
    session(second)
    report.write_bytes(transcript)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('binary', type=Path)
    parser.add_argument('--output', type=Path, default=Path('.build/reports/rust-tui'))
    args = parser.parse_args()
    binary = args.binary.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix='acceptance-', dir=output))
    checks = []
    # PTY first: preexec_fn is used before any reader threads are created.
    terminal_test(binary, work, output / 'terminal.ansi')
    checks.append('PTY: arrow/Enter menus and forms, Unicode composition, safe default confirmation, persisted default save directory and prefilled filename, group-bound persisted draft, explicit file send, Tab panel focus, 36/60/80/100/120-column layouts, narrow settings, Ctrl+C/SIGTERM restoration')
    a = b = None
    try:
        a = Node(binary, work / 'a', output / 'nodes.log')
        b = Node(binary, work / 'b', output / 'nodes.log')
        a_boot = a.call('bootstrap')
        b_boot = b.call('bootstrap')
        assert a_boot['endpoint']['baseUrl'].startswith('http://127.0.0.1:')
        group = a.call('create_group', name='Rust TUI acceptance')['id']
        invite = a.call('create_invite', groupId=group)
        ticket = b.call('join_group', address=invite['baseUrl'], code=invite['code'])
        requests = a.call('list_join_requests', groupId=group)
        assert requests and 'pollToken' not in requests[0]
        a.call('respond_join', groupId=group, id=ticket['requestId'], allow=True)
        assert b.call('check_join', ticket=ticket)['status'] == 'approved'
        checks.append('Two production cores: invitation, pending request, approval and join')
        a.call('send_text', groupId=group, text='A → B 中文')
        wait_state(b, group, lambda s: any(m.get('text') == 'A → B 中文' for m in s['messages']))
        b.call('send_text', groupId=group, text='B → A')
        wait_state(a, group, lambda s: any(m.get('text') == 'B → A' for m in s['messages']))
        checks.append('Bidirectional text synchronization')
        source = work / 'payload 有空格.bin'
        source.write_bytes(os.urandom(512 * 1024))
        expected = hashlib.sha256(source.read_bytes()).hexdigest()
        sent = a.call('send_file', groupId=group, path=str(source))
        wait_state(b, group, lambda s: any(m['id'] == sent['id'] for m in s['messages']))
        saved = work / 'received-b.bin'
        b.call('save_file', groupId=group, id=sent['id'], path=str(saved))
        assert hashlib.sha256(saved.read_bytes()).hexdigest() == expected
        refusal = b.raw(json.dumps({'id': 'existing', 'method': 'save_file', 'params': {'groupId': group, 'id': sent['id'], 'path': str(saved)}}))
        assert not refusal['ok'] and hashlib.sha256(saved.read_bytes()).hexdigest() == expected
        sent_back = b.call('send_file', groupId=group, path=str(saved))
        wait_state(a, group, lambda s: any(m['id'] == sent_back['id'] for m in s['messages']))
        saved_back = work / 'received-a.bin'
        a.call('save_file', groupId=group, id=sent_back['id'], path=str(saved_back))
        assert hashlib.sha256(saved_back.read_bytes()).hexdigest() == expected
        checks.append('512 KiB bidirectional files: SHA-256 and no overwrite')
        assert not b.raw('not-json')['ok']
        assert not b.raw('{"method":"invalid-command"}')['ok']
        duplicate = subprocess.run([str(binary), '--json', '--data-dir', str(work / 'b')], input='', capture_output=True, text=True, timeout=10)
        assert duplicate.returncode != 0 and '已有拾传进程' in duplicate.stderr
        checks.append('Malformed requests remain recoverable; concurrent data directory rejected')
        b.close()
        b = Node(binary, work / 'b', output / 'nodes.log')
        restored = b.call('bootstrap')
        assert restored['device']['id'] == b_boot['device']['id']
        assert restored['endpoint']['port'] == b_boot['endpoint']['port']
        assert len(b.call('get_state', groupId=group)['messages']) >= 4
        checks.append('Restart preserves identity, listener port, group and history')
        report = {'passed': True, 'version': subprocess.check_output([str(binary), '--version'], text=True).strip(), 'checks': checks, 'fileSha256': expected, 'workDirectory': str(work), 'isolation': 'Generated files and groups; loopback-only listeners; no existing business files'}
        (output / 'acceptance.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(report, ensure_ascii=False, indent=2))
    finally:
        if b: b.close()
        if a: a.close()


if __name__ == '__main__':
    main()
