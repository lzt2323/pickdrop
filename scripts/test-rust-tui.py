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

    def session(action):
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 26, 100, 0, 0))
        original = termios.tcgetattr(slave)
        def controlling_terminal():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        process = subprocess.Popen([str(binary), '--data-dir', str(data)], stdin=slave, stdout=slave, stderr=slave, preexec_fn=controlling_terminal)
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
                process.wait()
            os.close(master)
            os.close(slave)

    def first(process, master, command, read_until):
        command('/create TUI-验收', '操作完成')
        command('/file ' + str(source), '附件已暂存')
        snapshot = json.loads(next(data.glob('group_*.json')).read_text())
        assert len(snapshot['events']) == 0, 'Staging sent a file without confirmation'
        command('/create TUI-另一群', '操作完成')
        group = json.loads((data / 'tui-drafts.json').read_text())[0]['group']
        command('/use ' + group, '操作完成')
        command('/help', '直接输入文字')
        os.write(master, b'\t')
        frame = read_until('TUI-另一群')
        assert '直接输入文字' not in frame, 'Tab retained details from the previous group'
        os.write(master, b'\t')
        read_until('终端 有空格.txt')
        os.write(master, b'\x03')
    session(first)

    def second(process, master, command, read_until):
        read_until('终端 有空格.txt', reuse=True)
        group = json.loads((data / 'tui-drafts.json').read_text())[0]['group']
        command('/send', '操作完成')
        snapshot = json.loads((data / ('group_' + group + '.json')).read_text())
        assert len(snapshot['events']) == 1
        assert json.loads((data / 'tui-drafts.json').read_text()) == []
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 8, 24, 0, 0))
        os.kill(process.pid, signal.SIGWINCH)
        read_until('终端至少需要')
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
        os.kill(process.pid, signal.SIGWINCH)
        read_until('拾传')
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
    checks.append('PTY: UTF-8/space paths, stage without send, persisted draft, group switching clears old details and retains draft target, explicit send, resize, Ctrl+C/SIGTERM terminal restoration')
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
