"""Installer integration tests with isolated homes and local download fixtures."""
import hashlib
import io
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/install-linux.sh'


@unittest.skipUnless(os.uname().sysname == 'Linux', 'requires Linux mv and sha256sum')
class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pickdrop-install-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / 'home with spaces'
        self.home.mkdir()
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.archive = self.root / 'package.tar.gz'
        with tarfile.open(self.archive, 'w:gz') as archive:
            data = b'#!/bin/sh\necho fixture\n'
            info = tarfile.TarInfo('pickdrop')
            info.size = len(data)
            info.mode = 0o755
            archive.addfile(info, io.BytesIO(data))
        digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.script = self.root / 'install.sh'
        source = SCRIPT.read_text().replace(
            '4cc54fbfcbb62aa368ea54cdbe6fe2b60583111720b5e4b7773f0626a27a48ed', digest)
        self.script.write_text(source)
        self.mock('uname', 'case "$1" in -s) echo Linux;; -m) echo x86_64;; esac')
        self.mock('getconf', 'echo "glibc 2.35"')
        self.mock('curl', 'while [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then cp "$FIXTURE" "$2"; exit; fi; shift; done; exit 9')
        self.env = dict(os.environ, HOME=str(self.home), FIXTURE=str(self.archive),
                        PATH=str(self.bin) + ':' + os.environ['PATH'])
        self.target = self.home / '.local/bin/pickdrop'

    def mock(self, name, body):
        p = self.bin / name
        p.write_text('#!/bin/sh\n' + body + '\n')
        p.chmod(0o755)

    def run_install(self, *args):
        return subprocess.run(['sh', str(self.script), *args], env=self.env, capture_output=True, text=True)

    def existing(self):
        self.target.parent.mkdir(parents=True)
        self.target.write_text('old version')

    def test_install_and_repeat_preserve_data(self):
        data = self.home / '.local/share/pickdrop/history'
        data.parent.mkdir(parents=True)
        data.write_text('keep me')
        for _ in range(2):
            result = self.run_install()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(os.access(self.target, os.X_OK))
            self.assertEqual(data.read_text(), 'keep me')
        self.assertEqual(list(self.target.parent.glob('.pickdrop-install.*')), [])

    def test_custom_directory_through_stdin(self):
        destination = self.root / 'custom apps'
        self.env.pop('HOME')
        for _ in range(2):
            result = subprocess.run(
                ['sh', '-s', '--', '--install-dir', str(destination)],
                input=self.script.read_text(), env=self.env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(os.access(destination / 'pickdrop', os.X_OK))
            self.assertIn(str(destination), result.stdout)
        self.assertFalse(self.target.exists())
        self.assertEqual(list(destination.glob('.pickdrop-install.*')), [])

    def test_invalid_arguments_preserve_existing(self):
        self.existing()
        for args in [('--install-dir',), ('--install-dir', ''),
                     ('--install-dir', 'relative/path'), ('--unknown',)]:
            with self.subTest(args=args):
                result = self.run_install(*args)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('拾传安装失败', result.stderr)
                self.assertEqual(self.target.read_text(), 'old version')

    def test_help_does_not_install(self):
        result = self.run_install('--help')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--install-dir', result.stdout)
        self.assertFalse(self.target.exists())

    def test_checksum_failure_preserves_existing(self):
        self.existing()
        self.archive.write_bytes(b'corrupt')
        result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('SHA-256', result.stderr)
        self.assertEqual(self.target.read_text(), 'old version')

    def test_network_failure_preserves_existing(self):
        self.existing()
        self.mock('curl', 'exit 22')
        self.assertNotEqual(self.run_install().returncode, 0)
        self.assertEqual(self.target.read_text(), 'old version')

    def test_unsupported_platforms(self):
        for tool, body in [('uname', 'case "$1" in -s) echo Linux;; -m) echo aarch64;; esac'), ('getconf', 'echo "glibc 2.31"')]:
            with self.subTest(tool=tool):
                self.mock(tool, body)
                self.assertNotEqual(self.run_install().returncode, 0)
                self.assertFalse(self.target.exists())
                self.mock('uname', 'case "$1" in -s) echo Linux;; -m) echo x86_64;; esac')

    def test_existing_symlink_is_not_replaced(self):
        self.existing()
        other = self.root / 'other'
        self.target.rename(other)
        self.target.symlink_to(other)
        self.assertNotEqual(self.run_install().returncode, 0)
        self.assertEqual(other.read_text(), 'old version')


if __name__ == '__main__':
    unittest.main()
