import argparse
import importlib.util
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import tomllib
import unittest
from unittest.mock import patch


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("install_codex_mcp", PROJECT_ROOT / "scripts/install_codex_mcp.py")
assert SPEC and SPEC.loader
INSTALLER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INSTALLER)


class CodexInstallationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="video learning installer ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.codex_home = self.root / "codex home"
        self.codex_home.mkdir()
        self.config = self.codex_home / "config.toml"
        self.original = 'model = "gpt-6.1-sol"\n# retain this comment\n\n[projects."/tmp/some project"]\ntrust_level = "trusted"\n\n[mcp_servers.unrelated]\ncommand = "/bin/true"\nargs = []\nenabled = true\nrequired = false\nenabled_tools = []\ndisabled_tools = []\n\n[mcp_servers.unrelated.env]\nKEEP = "private-test-value"\n'
        self.config.write_text(self.original)
        self.args = argparse.Namespace(workspace=str(self.root / "shared workspace"), db=str(self.root / "database location" / "videos.sqlite"), codex_home=str(self.codex_home), startup_timeout=30, tool_timeout=3600)

    @unittest.skipUnless(shutil.which("codex") and shutil.which("bun") and shutil.which("ffmpeg") and shutil.which("ffprobe"), "local Codex/Bun/ffmpeg tools required")
    def test_real_cli_preserves_other_config_and_reinstalls_with_spaces(self):
        target_skill = self.codex_home / "skills/video-learning"
        target_skill.mkdir(parents=True)
        (target_skill / "SKILL.md").write_text("custom previous skill")
        (target_skill / "user-note.txt").write_text("keep me")
        other_skill = self.codex_home / "skills/other/SKILL.md"
        other_skill.parent.mkdir()
        other_skill.write_text("another skill")

        first = INSTALLER.install(self.args)
        config = tomllib.loads(self.config.read_text())
        server = config["mcp_servers"]["video-learning"]
        self.assertEqual(INSTALLER.without_server(config), tomllib.loads(self.original))
        self.assertIn("# retain this comment", self.config.read_text())
        self.assertTrue(self.config.read_text().startswith(self.original))
        self.assertEqual(server["command"], os.path.abspath(shutil.which("bun")))
        self.assertEqual(server["args"], ["run", "--no-env-file", "--cwd", str(PROJECT_ROOT), str(PROJECT_ROOT / "src/cli.ts"), "mcp", "--workspace", self.args.workspace, "--db", self.args.db])
        self.assertEqual(server["startup_timeout_sec"], 30)
        self.assertEqual(server["tool_timeout_sec"], 3600)
        self.assertEqual(set(server["env"]), {"PATH"})
        self.assertIn(str(Path(shutil.which("ffmpeg")).parent), server["env"]["PATH"].split(os.pathsep))
        self.assertEqual(first["config_backup"].read_text(), self.original)
        self.assertEqual(stat.S_IMODE(first["config_backup"].stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.config.stat().st_mode), 0o600)
        self.assertEqual((first["skill_backup"] / "SKILL.md").read_text(), "custom previous skill")
        self.assertEqual((target_skill / "user-note.txt").read_text(), "keep me")
        self.assertEqual(other_skill.read_text(), "another skill")

        # Execute what Codex will launch from another project. A zero exit alone
        # is insufficient: malformed Bun argument order prints Bun help and exits 0.
        help_args = server["args"][:server["args"].index("mcp")] + ["help"]
        launched = subprocess.run([server["command"], *help_args], cwd=self.root, env={**os.environ, **server["env"]}, capture_output=True, text=True, timeout=30)
        self.assertEqual(launched.returncode, 0, launched.stderr)
        self.assertIn("video-learning\n\nCommands:", launched.stdout)

        second = INSTALLER.install(self.args)
        self.assertEqual(tomllib.loads(self.config.read_text()), config)
        self.assertTrue(self.config.read_text().startswith(self.original))
        self.assertIsNone(second["skill_backup"])
        self.assertEqual((target_skill / "SKILL.md").read_bytes(), (PROJECT_ROOT / "skills/video-learning/SKILL.md").read_bytes())

        # Reinstallation must not enable a disabled server or loosen tool policy.
        policy_config = self.config.read_text().replace("[mcp_servers.video-learning]\n", '[mcp_servers.video-learning]\nenabled = false\nrequired = true\ndisabled_tools = ["acquire_video"]\nenabled_tools = ["search_videos"]\ndefault_tools_approval_mode = "prompt"\n')
        policy_config += '\n[mcp_servers.video-learning.tools.search_videos]\napproval_mode = "prompt"\nenabled = false\n'
        self.config.write_text(policy_config)
        previous = tomllib.loads(policy_config)
        INSTALLER.install(self.args)
        self.assertEqual(tomllib.loads(self.config.read_text()), previous)

    def test_failure_restores_original_and_does_not_echo_cli_secrets(self):
        binaries = {name: f"/bin/{name}" for name in ("bun", "codex", "ffmpeg", "ffprobe")}

        def failing_cli(*args, **kwargs):
            self.config.write_text('unrelated = "modified"\n')
            return subprocess.CompletedProcess(args[0], 1, "", "secret-token")

        with patch.object(INSTALLER, "validate_dependencies", return_value=binaries), patch.object(INSTALLER.subprocess, "run", side_effect=failing_cli):
            with self.assertRaisesRegex(RuntimeError, "exit code 1") as error:
                INSTALLER.install(self.args)
        self.assertNotIn("secret-token", str(error.exception))
        self.assertEqual(self.config.read_text(), self.original)

    def test_timeouts_only_change_the_server_table_even_with_decoy_text(self):
        document = 'note = """\n[mcp_servers.video-learning]\nstartup_timeout_sec = 999\n"""\n\n[mcp_servers."video-learning"]\ncommand = "/bin/true"\nstartup_timeout_sec = 10\ntool_timeout_sec = 20\n\n[mcp_servers.other]\nstartup_timeout_sec = 40\n'
        result = tomllib.loads(INSTALLER.set_timeouts(document, 30, 3600))
        expected = tomllib.loads(document)
        expected["mcp_servers"]["video-learning"].update(startup_timeout_sec=30, tool_timeout_sec=3600)
        self.assertEqual(result, expected)

    def test_merge_replaces_discontiguous_target_tables_and_preserves_other_text(self):
        prefix = '# Keep formatting\nmodel="gpt-6.1-sol"\n\n'
        unrelated = '[mcp_servers.other]\ncommand="/bin/true"\nargs = []\nenabled = true\n\n'
        suffix = '[projects."/a path"]\ntrust_level="trusted"\n'
        original = prefix + '[mcp_servers."video-learning"]\ncommand = "old"\n\n' + unrelated + '[mcp_servers."video-learning".env]\nOLD = "value"\n\n' + suffix
        server = {"command": "new", "args": ["path with spaces"], "env": {"PATH": "/usr/bin"}}
        merged = INSTALLER.merge_server(original, server)
        expected = tomllib.loads(original)
        expected["mcp_servers"]["video-learning"] = server
        self.assertEqual(tomllib.loads(merged), expected)
        self.assertTrue(merged.startswith(prefix))
        self.assertIn(unrelated, merged)
        self.assertTrue(merged.endswith(suffix))
        self.assertEqual(INSTALLER.merge_server(merged, server), merged)

    def test_unsupported_inline_server_layout_fails_without_a_lossy_rewrite(self):
        original = 'mcp_servers = { video-learning = { command = "old" }, other = { command = "keep", args = [] } }\n'
        with self.assertRaisesRegex(RuntimeError, "original configuration was preserved"):
            INSTALLER.merge_server(original, {"command": "new"})


if __name__ == "__main__":
    unittest.main()
