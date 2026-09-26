"""SEC submission discovery with durable issuer history cursors."""

from __future__ import annotations

import re
from typing import Any

from ..common import fetch_json, instant, iso
from .base import Adapter, array, bounded


class SecSubmissions(Adapter):
    rightsMode = "OFFICIAL_PUBLIC_DATA"

    def __init__(self, ctx):
        super().__init__(ctx, "SEC")
        self.attempted = self.completed = self.skipped = 0

    def configured(self):
        return bool(self.ctx.config.secUserAgent)

    async def submission_file(self, cik, filename=None):
        filename = filename or f"CIK{cik}.json"
        if not self.configured() or not re.fullmatch(r"\d{10}", cik) or cik == "0000000000":
            raise ValueError("SEC configuration/CIK invalid.")
        if filename != f"CIK{cik}.json" and not re.fullmatch(
            rf"CIK{cik}-submissions-\d+\.json", filename
        ):
            raise ValueError("Unsafe SEC history filename.")
        try:
            value = await fetch_json(
                self.ctx,
                "SEC",
                f"https://data.sec.gov/submissions/{filename}",
                operation="submissions",
                headers={"User-Agent": self.ctx.config.secUserAgent, "Accept": "application/json"},
            )
            self.attempted += 1
            self.completed += 1
            return value
        except Exception as error:
            if getattr(error, "requestAttempted", True):
                self.attempted += 1
            else:
                self.skipped += 1
            raise
        finally:
            self.discoveryMetadata.update(
                requestsAttempted=self.attempted,
                requestsCompleted=self.completed,
                requestsSkipped=self.skipped,
            )

    @staticmethod
    def candidates(cik, name, rows, tickers):
        if not isinstance(rows, dict):
            raise ValueError("Invalid SEC rows.")  # noqa: TRY004 - preserve the deployed provider validation exception contract
        accessions = array(rows.get("accessionNumber"), 20000)
        for key in ("filingDate", "form", "primaryDocument"):
            if len(array(rows.get(key), 20000)) != len(accessions):
                raise ValueError("SEC columns differ in length.")
        for key in ("acceptanceDateTime", "reportDate"):
            if key in rows and len(array(rows[key], 20000)) != len(accessions):
                raise ValueError("SEC columns differ in length.")
        result = []
        for index, accession in enumerate(accessions):
            if not isinstance(accession, str) or not re.fullmatch(r"\d{10}-\d{2}-\d{6}", accession):
                raise ValueError("Invalid SEC accession.")
            primary = bounded(rows["primaryDocument"][index], 1024)
            if any(
                not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", segment) or segment in (".", "..")
                for segment in primary.split("/")
            ):
                raise ValueError("Unsafe SEC document path.")
            accepted = rows.get("acceptanceDateTime", [None] * len(accessions))[index]
            published = (
                iso(instant(accepted))
                if isinstance(accepted, str) and re.search(r"(?:Z|[+-]\d\d:\d\d)$", accepted)
                else None
            )
            original: dict[str, Any] = {}
            truncated = False
            for key, values in rows.items():
                if (
                    not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,79}", key)
                    or not isinstance(values, list)
                    or index >= len(values)
                ):
                    continue
                value = values[index]
                if isinstance(value, (dict, list)):
                    continue
                if len(original) >= 40:
                    truncated = True
                    continue
                if isinstance(value, str) and len(value) > 2048:
                    value = value[:2048]
                    truncated = True
                original[key] = value
            form = bounded(rows["form"][index], 256)
            result.append(
                {
                    "connector": "SEC",
                    "externalId": accession,
                    "title": f"{form} — {name}",
                    "url": f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession.replace('-', '')}/{primary}",
                    "publishedAt": published,
                    "sourceName": "SEC EDGAR",
                    "tickers": sorted(set(tickers)),
                    "tags": [form],
                    "rightsMode": "OFFICIAL_PUBLIC_DATA",
                    "metadata": {
                        "cik": cik,
                        "form": form,
                        "filingDate": rows["filingDate"][index],
                        "reportDate": rows.get("reportDate", [None] * len(accessions))[index],
                        "acceptanceDateTime": accepted,
                        "primaryDocument": primary,
                        "originalFiling": original,
                        "originalFilingTruncated": truncated,
                    },
                }
            )
        return result

    async def batches(self, scope, store, *, backfill=False, **kwargs):
        if not self.configured() or not scope:
            return
        cik = str(next((c.get("cik") for c in scope if c.get("cik")), "")).zfill(10)
        if cik == "0000000000":
            return
        stream = f"SUBMISSIONS:CIK:{cik}"
        checkpoint = await store.load(self.name, stream)
        revision, previous = checkpoint["revision"], checkpoint["metadata"]
        parsed = await self.submission_file(cik)
        if str(parsed.get("cik", "")).zfill(10) != cik:
            raise ValueError("SEC submissions CIK mismatch.")
        name = bounded(parsed.get("name"), 16000)
        filings = parsed.get("filings", {})
        files = [bounded(file.get("name"), 255) for file in array(filings.get("files", []), 2000)]
        if any(not re.fullmatch(rf"CIK{cik}-submissions-\d+\.json", f) for f in files):
            raise ValueError("Unsafe SEC history filename.")
        tickers = [c["ticker"] for c in scope if c.get("ticker")]
        recent = self.candidates(cik, name, filings.get("recent"), tickers)
        baseline = previous.get("baselineComplete") is True and isinstance(
            previous.get("newestKnownAccession"), str
        )
        gap = not any(c["externalId"] == previous.get("newestKnownAccession") for c in recent)
        pending = [v for v in previous.get("pendingFiles", []) if isinstance(v, str)]
        additions = (
            files
            if (not baseline or gap or backfill) and not pending
            else [f for f in files if gap or f not in previous.get("completedFiles", [])]
            if pending or gap
            else []
        )
        remaining = list(dict.fromkeys(pending + additions))
        completed = list(previous.get("completedFiles", [])) if pending else []
        metadata = {
            **previous,
            "provider": "SEC",
            "capability": "SUBMISSIONS_GAP_RECOVERY",
            "lastFetchedAt": iso(),
            "lastSourceFile": "recent",
            "newestKnownAccession": recent[0]["externalId"]
            if recent
            else previous.get("newestKnownAccession"),
            "pendingFiles": remaining,
            "completedFiles": completed,
            "cursor": remaining[0] if remaining else None,
            "baselineComplete": baseline or not remaining,
            "incomplete": bool(remaining),
            "truncated": False,
            "mode": "BACKFILL" if backfill or not baseline else "POLL",
        }
        if not remaining:
            metadata["lastSuccessfulObservedAt"] = iso()
        self.discoveryMetadata.update(metadata, checkpoint=stream)
        yield {
            "candidates": recent,
            "suppressAlerts": backfill or not baseline,
            "checkpoint": {"stream": stream, "expected": revision, "metadata": dict(metadata)},
        }
        revision += 1
        requests = 1
        while remaining and requests < self.ctx.config.secBackfillMaxRequests:
            filename = remaining[0]
            rows = await self.submission_file(cik, filename)
            requests += 1
            candidates = self.candidates(cik, name, rows, tickers)
            remaining = remaining[1:]
            completed = [*completed, filename]
            metadata = {
                **metadata,
                "lastFetchedAt": iso(),
                "lastSourceFile": filename,
                "pendingFiles": remaining,
                "completedFiles": completed,
                "cursor": remaining[0] if remaining else None,
                "baselineComplete": baseline or not remaining,
                "incomplete": bool(remaining),
            }
            if not remaining:
                metadata["lastSuccessfulObservedAt"] = iso()
            self.discoveryMetadata.update(metadata, checkpoint=stream)
            yield {
                "candidates": candidates,
                "suppressAlerts": True,
                "checkpoint": {"stream": stream, "expected": revision, "metadata": dict(metadata)},
            }
            revision += 1
        self.discoveryWasTruncated |= bool(remaining)
        self.discoveryMetadata.update(requestsInIssuerRun=requests)
