import pytest

from orsem_worker.analysis.documents import (
    diff_document_tables,
    extract_document_tables,
    link_document_facts,
)
from orsem_worker.disclosures.primitives import OpenDartPayloadError

HTML = b"""<!DOCTYPE html><html><body>
<ix:header><xbrli:context id="c"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0000001234</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:instant>2025-09-30</xbrli:instant></xbrli:period></xbrli:context><xbrli:unit id="u"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit></ix:header>
<h2>Consolidated Balance Sheets</h2><table><tr><th>Account</th><th>2025</th></tr><tr><td>Assets</td><td><ix:nonFraction name="us-gaap:Assets" contextRef="c" unitRef="u" scale="3" decimals="-3" format="ixt:num-dot-decimal">1,234</ix:nonFraction></td></tr></table>
<h2>Debt and leases</h2><p>Our debt matures in 2030.</p><script>dangerous()</script><img src="https://bad.test/exfil" onerror="dangerous()">
</body></html>"""


def test_html_inline_xbrl_has_safe_text_provenance_and_real_note_body():
    result = extract_document_tables(HTML, media_type="text/html")
    source = result["inlineFacts"][0]
    assert source["accountId"] == "us-gaap:Assets"
    assert source["value"] == "1234000"
    assert source["rawValue"] == "1,234"
    assert source["consolidated"] is True
    assert source["entityId"] == "0000001234"
    assert source["periodEnd"] == "2025-09-30"
    assert any("Our debt matures" in note["text"] for note in result["notes"])
    assert "dangerous()" not in str(result["notes"])
    assert "onerror" not in str(result["tables"])


def test_source_cell_link_requires_unique_matching_context_and_compares_value():
    result = extract_document_tables(HTML, media_type="text/html")
    facts = [
        {
            "id": "assets",
            "accountId": "us-gaap:Assets",
            "periodStart": None,
            "periodEnd": "2025-09-30",
            "currency": "USD",
            "scope": "CFS",
            "status": "AVAILABLE",
            "value": "1234000",
        }
    ]
    checks = link_document_facts(result["tables"], facts)
    assert checks[0]["status"] == "PASS"
    assert any(c.get("factId") == "assets" for t in result["tables"] for c in t["cells"])
    facts[0]["value"] = "1234001"
    assert link_document_facts(result["tables"], facts)[0]["status"] == "REVIEW"
    facts[0]["currency"] = "KRW"
    assert link_document_facts(result["tables"], facts) == []


def test_dimensioned_context_never_links_to_whole_company():
    html = HTML.replace(
        b"</xbrli:entity>",
        b'<xbrli:segment><xbrldi:explicitMember dimension="x:Axis">x:Segment</xbrldi:explicitMember></xbrli:segment></xbrli:entity>',
    )
    result = extract_document_tables(html, media_type="text/html")
    assert result["inlineFacts"][0]["dimensions"] is True
    assert link_document_facts(result["tables"], []) == []


def test_unsafe_html_xml_and_expansion_are_rejected():
    for content, media in (
        (b'<!DOCTYPE html SYSTEM "file:///etc/passwd"><html/>', "text/html"),
        (
            b'<!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><DOCUMENT>&a;</DOCUMENT>',
            "application/xml",
        ),
    ):
        with pytest.raises((ValueError, OpenDartPayloadError)):
            extract_document_tables(content, media_type=media)
    with pytest.raises(ValueError):
        extract_document_tables(HTML, media_type="text/html", max_tables=0)


def test_row_moves_are_not_changes_and_unconfirmed_relation_is_not_complete():
    def document(rows):
        return {
            "tables": [
                {
                    "id": "table",
                    "title": "재무",
                    "section": "본문",
                    "rowCount": len(rows),
                    "cells": [
                        {"row": ri, "column": ci, "text": value}
                        for ri, row in enumerate(rows)
                        for ci, value in enumerate(row)
                    ],
                }
            ]
        }

    before = document([["자산", "100"], ["부채", "60"]])
    after = document([["부채", "60"], ["자산", "100"]])
    assert diff_document_tables(before, after, confirmed=True)["differences"] == []
    assert diff_document_tables(before, after, confirmed=False)["status"] == "WAITING"


def test_confirmed_diff_tracks_narrative_and_tag_changes_without_guessing_repeated_titles():
    before = extract_document_tables(HTML, media_type="text/html")
    after = extract_document_tables(
        HTML.replace(b"in 2030", b"in 2031").replace(b"us-gaap:Assets", b"us-gaap:OtherAssets"),
        media_type="text/html",
    )
    result = diff_document_tables(before, after, confirmed=True)
    assert result["status"] == "COMPLETE"
    assert any(d["kind"] == "CLASSIFICATION" for d in result["differences"])
    narrative = next(d for d in result["differences"] if d["kind"] == "TEXT")
    assert "2030" in narrative["before"] and "2031" in narrative["after"]
    assert narrative["beforeNoteKey"] and narrative["afterNoteKey"]
    after["notes"].append(after["notes"][0])
    assert diff_document_tables(before, after, confirmed=True)["status"] == "PARTIAL"
