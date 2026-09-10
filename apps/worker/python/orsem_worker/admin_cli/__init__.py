"""Native parser administration commands. No connector or queue initialization."""

from __future__ import annotations

import argparse


class _Once(argparse.Action):
    """Keep explicit output/source/apply flags unambiguous, as in the previous CLI."""

    def __call__(self, parser, namespace, values, option_string=None):
        if getattr(namespace, self.dest, None) is not None:
            parser.error("Duplicate argument: " + str(option_string))
        setattr(namespace, self.dest, self.const if self.nargs == 0 else values)


async def run(command, args):
    parser = argparse.ArgumentParser(prog=command, allow_abbrev=False)
    if command == "parser-corpus-audit":
        parser.add_argument("--snapshot", required=True, action=_Once)
        parser.add_argument("--old-results", required=True, action=_Once)
        parser.add_argument("--output-dir", required=True, action=_Once)
        from .corpus import audit_corpus

        return await audit_corpus(parser.parse_args(args))
    if command == "stage-parser-corpus":
        parser.add_argument("--snapshot", required=True, action=_Once)
        parser.add_argument("--corpus", required=True, action=_Once)
        parser.add_argument("--output-dir", required=True, action=_Once)
        parser.add_argument("--apply", action=_Once, nargs=0, const=True)
        from .staging import stage_corpus

        return await stage_corpus(parser.parse_args(args))
    if command == "export-parser-review-audit":
        parser.add_argument("--output-dir", required=True, action=_Once)
        from .review_export import export_audit

        return await export_audit(parser.parse_args(args))
    if command == "parser-rollout-backup":
        modes = parser.add_subparsers(dest="mode", required=True)
        backup = modes.add_parser("backup")
        backup.add_argument("--env-file", required=True, action=_Once)
        backup.add_argument("--output-dir", required=True, action=_Once)
        restore = modes.add_parser("restore-check")
        restore.add_argument("--socket-path", required=True, action=_Once)
        restore.add_argument("--database", required=True, action=_Once)
        restore.add_argument("--backup-dir", required=True, action=_Once)
        restore.add_argument("--output-dir", required=True, action=_Once)
        from .backup import run_backup

        return await run_backup(parser.parse_args(args))
    parser.error("Unknown parser administration command")
