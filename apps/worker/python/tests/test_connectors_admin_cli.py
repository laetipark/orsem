"""Offline administration artifacts, source verification, and staging protection."""

import io
import json
import os
import zipfile
from pathlib import Path

import pytest

from orsem_worker.admin_cli import run
from orsem_worker.admin_cli.backup import read_verified_backup
from orsem_worker.admin_cli.common import AdminError, csv, prepare_output, write_private
from orsem_worker.admin_cli.corpus import field_map
from orsem_worker.admin_cli.review_export import kst_instant, source_date, source_dates
from orsem_worker.admin_cli.staging import same_json
from orsem_worker.core import identifier, json_text, sha256


def corpus_fixture(root):
    data = (
        "<DOCUMENT><TABLE><TR><TH>변동일</TH><TH>증권의 종류</TH><TH>취득/처분방법</TH><TH>증감수량</TH><TH>주당거래단가</TH></TR><TR><TD>2026-09-01</TD><TD>보통주</TD><TD>장내매수</TD><TD>2</TD><TD>3000</TD></TR></TABLE></DOCUMENT>"
    ).encode()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("synthetic.xml", data)
    data = buffer.getvalue()
    source = root / "synthetic.zip"
    source.write_bytes(data)
    filing = {
        "id": identifier(),
        "rcept_no": "20260910000001",
        "company_id": identifier(),
        "report_name": "임원ㆍ주요주주특정증권등소유상황보고서",
        "detail_type": "D002",
        "source_detail_type": "D002",
        "active_parse_run_id": "protected",
        "classification_status": "CONFIRMED",
    }
    previous = {
        "id": identifier(),
        "filing_id": filing["id"],
        "raw_sha256": sha256(data),
        "status": "FAILED",
        "started_at": "2026-09-10 01:00:00.000",
    }
    document = {
        "id": identifier(),
        "filing_id": filing["id"],
        "sha256": sha256(data),
        "object_uri": source.as_uri(),
        "byte_size": str(len(data)),
        "retrieved_at": "2026-09-10 01:00:00.000",
        "rights_mode": "OFFICIAL_PUBLIC_DATA",
    }
    snapshot = {"filings": [filing], "runs": [previous], "documents": [document]}
    (root / "snapshot.json").write_text(json_text(snapshot))
    (root / "old.json").write_text(
        json_text([{"id": previous["id"], "result_json": {"parsed": None}}])
    )
    return snapshot


@pytest.mark.asyncio
async def test_native_corpus_and_staging_dry_run_real_private_artifacts(tmp_path):
    snapshot = corpus_fixture(tmp_path)
    summary = await run(
        "parser-corpus-audit",
        [
            "--snapshot",
            str(tmp_path / "snapshot.json"),
            "--old-results",
            str(tmp_path / "old.json"),
            "--output-dir",
            str(tmp_path / "audit"),
        ],
    )
    assert (
        summary["runs"] == 1
        and summary["sources_verified"] == 1
        and summary["sources_unchanged"] == 1
    )
    corpus = json.loads((tmp_path / "audit/corpus-audit.json").read_text())
    assert corpus["runs"][0]["outcome"] != "FAILED"
    assert "장내매수" not in json_text(corpus["runs"][0]["fields"])
    assert os.stat(tmp_path / "audit/corpus-audit.json").st_mode & 0o077 == 0
    staged = await run(
        "stage-parser-corpus",
        [
            "--snapshot",
            str(tmp_path / "snapshot.json"),
            "--corpus",
            str(tmp_path / "audit/corpus-audit.json"),
            "--output-dir",
            str(tmp_path / "stage"),
        ],
    )
    assert (
        staged["mode"] == "DRY_RUN"
        and staged["activated"] == staged["notifications"] == staged["networkCrosschecks"] == 0
    )
    manifest = json.loads((tmp_path / "stage/staging-candidates.json").read_text())[0]
    assert (
        manifest["projectionApplied"] is False
        and manifest["protectedActiveParseRunId"] == "protected"
    )
    assert manifest["status"] == "PARTIAL"
    original = snapshot["documents"][0]
    Path(original["object_uri"].removeprefix("file://")).write_text("<changed/>")
    with pytest.raises(AdminError, match="SOURCE_SHA_MISMATCH"):
        await run(
            "stage-parser-corpus",
            [
                "--snapshot",
                str(tmp_path / "snapshot.json"),
                "--corpus",
                str(tmp_path / "audit/corpus-audit.json"),
                "--output-dir",
                str(tmp_path / "stale"),
            ],
        )


@pytest.mark.asyncio
async def test_apply_requires_explicit_database_after_preflight(tmp_path, monkeypatch):
    corpus_fixture(tmp_path)
    await run(
        "parser-corpus-audit",
        [
            "--snapshot",
            str(tmp_path / "snapshot.json"),
            "--old-results",
            str(tmp_path / "old.json"),
            "--output-dir",
            str(tmp_path / "audit"),
        ],
    )
    monkeypatch.delenv("ORSEM_STAGE_DATABASE_URL", raising=False)
    with pytest.raises(AdminError, match="EXPLICIT_STAGE_DATABASE_REQUIRED"):
        await run(
            "stage-parser-corpus",
            [
                "--snapshot",
                str(tmp_path / "snapshot.json"),
                "--corpus",
                str(tmp_path / "audit/corpus-audit.json"),
                "--output-dir",
                str(tmp_path / "stage"),
                "--apply",
            ],
        )
    assert (tmp_path / "stage/staging-preflight.json").is_file()
    assert not (tmp_path / "stage/staging-summary.json").exists()


def test_external_output_symlink_and_source_text_hashes(tmp_path):
    repository = Path(__file__).resolve().parents[4]
    redirect = tmp_path / "redirect"
    redirect.symlink_to(repository, target_is_directory=True)
    with pytest.raises(AdminError, match="OUTSIDE_REPOSITORY"):
        prepare_output(redirect / "private-output")
    output = prepare_output(tmp_path / "safe")
    secret = tmp_path / "secret"
    secret.write_text("untouched")
    (output / "result.json").symlink_to(secret)
    with pytest.raises(OSError):
        write_private(output, "result.json", {"new": "data"})
    assert secret.read_text() == "untouched"
    field = field_map({"nameRaw": "DO_NOT_EXPORT", "quantity": "100"})
    assert field["nameRaw"]["sha256"] == sha256(
        "DO_NOT_EXPORT"
    ) and "DO_NOT_EXPORT" not in json_text(field)
    assert csv(
        [{"id": "001234567890123456", "title": "=EXEC()"}],
        [{"key": "id", "label": "id", "opaque": True}, "title"],
    ).startswith('\ufeff"id","title"\r\n"\'001234567890123456","\'=EXEC()"')


def test_kst_and_date_only_are_not_conflated():
    assert kst_instant("2026-09-10 15:01:02.003") == "2026-09-11T00:01:02.003+09:00"
    assert source_date("2026-09-10") == "2026-09-10"
    assert source_dates('["2026-09-10",null]') == ["2026-09-10", None]
    with pytest.raises(AdminError):
        source_date("2026-02-30")
    with pytest.raises(AdminError):
        kst_instant("not-a-timestamp")


def test_private_backup_verifies_completion_and_every_hash(tmp_path):
    root = prepare_output(tmp_path / "backup")
    schema = write_private(root, "schemas.json", {}, exclusive=True)
    table = write_private(root, "rows.json", [{"id": "one"}], exclusive=True)
    manifest = {
        "version": 1,
        "schema": schema,
        "tables": {"synthetic": {**table, "count": 1, "columns": ["id"], "primaryKeys": ["id"]}},
    }
    entry = write_private(root, "manifest.json", manifest, exclusive=True)
    write_private(root, "backup-complete.json", {"manifestSha256": entry["sha256"]}, exclusive=True)
    assert read_verified_backup(root)["tables"]["synthetic"] == [{"id": "one"}]
    (root / "rows.json").write_text("[]")
    with pytest.raises(AdminError, match="HASH_MISMATCH"):
        read_verified_backup(root)


def test_reuse_numeric_comparison_does_not_accept_other_types():
    assert same_json({"a": 1.2}, {"a": 1.2 + 2e-16})
    assert not same_json({"a": 1}, {"a": 1.0001})
    assert not same_json(True, 1)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("command", "arguments"),
    [
        (
            "parser-corpus-audit",
            [
                "--snapshot",
                "first",
                "--snapshot",
                "second",
                "--old-results",
                "old",
                "--output-dir",
                "out",
            ],
        ),
        (
            "stage-parser-corpus",
            ["--snapshot", "s", "--corpus", "c", "--output-dir", "out", "--apply", "--apply"],
        ),
        ("export-parser-review-audit", ["--output-dir", "one", "--output-dir=two"]),
        (
            "parser-rollout-backup",
            ["backup", "--env-file", "e", "--output-dir", "one", "--output-dir", "two"],
        ),
    ],
)
async def test_admin_duplicate_destination_and_apply_fail_before_io(command, arguments, capsys):
    with pytest.raises(SystemExit) as failure:
        await run(command, arguments)
    assert failure.value.code == 2
    assert "Duplicate argument:" in capsys.readouterr().err
