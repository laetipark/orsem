"""Synthetic regression cases ported from the deployed OpenDART/SEC parser suite."""

from __future__ import annotations

import io
import zipfile
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from orsem_worker.disclosures.ai_review import (
    aggregate_classification,
    claim_decision,
    processing_lease_ms,
    rearm_plan,
    select_candidates,
)
from orsem_worker.disclosures.extractors import extract_trading
from orsem_worker.disclosures.lifecycle import validate_persisted
from orsem_worker.disclosures.matches import canonical_integer, confirmed, reporter_key
from orsem_worker.disclosures.narrative import meeting_instant
from orsem_worker.disclosures.parser import parse_disclosure
from orsem_worker.disclosures.policy import (
    classify_filing,
    crosscheck_allows_projection,
    reuse_fingerprint,
)
from orsem_worker.disclosures.primitives import (
    OpenDartApiError,
    OpenDartPayloadError,
    classify_method,
    date_only,
    multiply,
    parse_decimal,
    parse_integer,
    unit_price,
)
from orsem_worker.disclosures.sec import ownership_url, parse_ownership
from orsem_worker.disclosures.tables import canonicalize_tables
from orsem_worker.disclosures.xml_archive import (
    assert_safe_xml,
    decode_xml,
    merge_candidate_errors,
    normalize_xml,
    read_archive,
)

FIXTURES = Path(__file__).parent / "fixtures" / "disclosures"


def archive(files: dict, compression=zipfile.ZIP_STORED) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=compression) as zipped:
        for name, value in files.items():
            zipped.writestr(name, value)
    return output.getvalue()


def fixture_parse(kind="D002"):
    name = kind.lower() + ".xml"
    return parse_disclosure(archive({name: (FIXTURES / name).read_bytes()}), kind)


def test_domain_separation_and_exact_numbers():
    report = fixture_parse()
    assert report["reporterName"] == "홍길동"
    first = report["transactions"][0]
    assert (
        first["eventDate"],
        first["nature"],
        first["quantity"],
        first["unitPrice"],
        first["amount"],
    ) == ("2026-09-01", "MARKET_BUY", "10000", "32500", "325000000")
    assert report["transactions"][1]["nature"] == "OPTION_EXERCISE"
    holder = fixture_parse("D001")
    assert holder["sharesAfter"] == "1200000"
    assert holder["changes"][0]["quantity"] == "200000"
    assert "transactions" not in holder
    planned = fixture_parse("D005")
    assert planned["planItems"][0]["plannedStartDate"] == "2026-09-05"
    assert planned["planItems"][0]["plannedEndDate"] == "2026-10-04"
    assert planned["planItems"][0]["nature"] == "MARKET_SELL"
    assert "transactions" not in planned
    assert validate_persisted(report) == report


@pytest.mark.parametrize(
    "raw,nature,direction",
    [
        ("장내매수", "MARKET_BUY", "INCREASE"),
        ("장내매도", "UNKNOWN", "INCREASE"),
        ("신규선임", "REPORTING_STATUS_CHANGE", "UNKNOWN"),
        ("기타 증가", "UNKNOWN", "INCREASE"),
        ("장내매수 관련 보고", "UNKNOWN", "INCREASE"),
    ],
)
def test_method_allowlist_never_infers_market_buy(raw, nature, direction):
    result = classify_method(raw, "100")
    assert (result["nature"], result["direction"]) == (nature, direction)


def test_unsigned_plan_direction_and_suffix_conflicts():
    assert classify_method("장내매도", "100", True)["nature"] == "MARKET_SELL"
    assert classify_method("기타 증가", "100", True)["direction"] == "UNKNOWN"
    assert (
        classify_method("장내매수(-)", "100")["warnings"][0]["code"] == "METHOD_QUANTITY_CONFLICT"
    )
    assert classify_method("주식분할", "-10")["nature"] == "STOCK_SPLIT_MERGER"


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("1,000주", "1000"),
        ("(2)천주", "-2000"),
        ("3백만주", "3000000"),
        ("−00012", "-12"),
        ("0", "0"),
    ],
)
def test_integer_normalization(raw, expected):
    assert parse_integer(raw)["value"] == expected


def test_numeric_safety_precision_units_and_multiplication():
    assert parse_integer("10억원")["warning"]["code"] == "INVALID_SHARE_UNIT"
    assert parse_integer("9" * 33)["warning"]["code"] == "NUMERIC_OUT_OF_RANGE"
    assert parse_decimal("1.1234567")["warning"]["code"] == "NUMERIC_SCALE_EXCEEDED"
    assert parse_decimal("1.2500억원")["value"] == "125000000"
    assert parse_decimal("(1.25)")["value"] == "-1.25"
    assert multiply("9007199254740993", "0.123456") == "1111992791193304.031808"
    assert multiply("9" * 32, "1000") is None
    assert date_only("2026-02-30") is None
    assert date_only("2024년 2월 29일") == "2024-02-29"


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("취득(10,000)", "10000"),
        ("(10000)", "10000"),
        ("10000(원)", "10000"),
        ("10000(-)", "10000"),
        ("-", None),
        ("(-)", None),
        ("-10", None),
    ],
)
def test_unit_price_annotations(raw, expected):
    assert unit_price(raw)["value"] == expected


def test_archive_safety_and_encoding():
    for filename, expected in [
        ("../escape.xml", "ZIP_PATH_TRAVERSAL"),
        ("/root.xml", "ZIP_PATH_TRAVERSAL"),
        ("C:/x.xml", "ZIP_PATH_TRAVERSAL"),
    ]:
        with pytest.raises(OpenDartPayloadError) as caught:
            read_archive(archive({filename: "<x/>"}))
        assert caught.value.code == expected
    with pytest.raises(OpenDartPayloadError, match="중첩"):
        read_archive(archive({"x.zip": archive({"x.xml": "<x/>"})}))
    repeated = "<x>" + "a" * 100000 + "</x>"
    with pytest.raises(OpenDartPayloadError) as caught:
        read_archive(archive({"x.xml": repeated}, zipfile.ZIP_DEFLATED))
    assert caught.value.code == "ZIP_COMPRESSION_RATIO_LIMIT"
    assert read_archive(archive({"x.xml": repeated}))["entriesSeen"] == 1
    with pytest.raises(OpenDartPayloadError):
        read_archive(archive({"x.xml": "<x/>"}), {"maxEntries": 201})
    for encoding in ("CP949", "EUC-KR"):
        xml = f'<?xml version="1.0" encoding="{encoding}"?><x>한글</x>'
        assert decode_xml(xml.encode(encoding), "x.xml") == xml
    with pytest.raises(OpenDartApiError) as caught:
        read_archive((FIXTURES / "error-020.xml").read_bytes())
    assert caught.value.retryPolicy == "NEXT_KST_DAY"


@pytest.mark.parametrize(
    "xml",
    [
        "<!DOCTYPE x><x/>",
        '<!ENTITY x "y"><x/>',
        '<x xmlns:xi="http://www.w3.org/2001/XInclude"/>',
        "<?execute instruction?><x/>",
    ],
)
def test_forbidden_xml_features(xml):
    with pytest.raises(OpenDartPayloadError):
        assert_safe_xml(xml)


def test_canonical_tables_bounded_provenance_and_single_entity_decode():
    result = canonicalize_tables((FIXTURES / "d002.xml").read_text(), "d002.xml")
    assert result["tables"][1]["rows"][1] == [
        "소유상황 변동일",
        "특정증권등의 종류",
        "취득/처분방법",
        "증감수량",
        "주당 거래단가",
    ]
    table = canonicalize_tables(
        "<DOCUMENT><TABLE><TR><TU>A &amp; B &lt;기준&gt; &amp;lt;</TU></TR></TABLE></DOCUMENT>",
        "encoded.xml",
    )["tables"][0]
    assert table["rows"][0][0] == "A & B <기준> &lt;"
    assert table["grid"][0][0]["rawText"] == "A &amp; B &lt;기준&gt; &amp;lt;"
    nested = canonicalize_tables(
        "<DOCUMENT><TABLE><TR><TD>layout<TABLE><TR><TH>변동일</TH></TR><TR><TD>2026-09-01</TD></TR></TABLE></TD></TR></TABLE></DOCUMENT>",
        "nested.xml",
    )
    assert len(nested["tables"]) == 2
    for xml in [
        "<N>" * 130 + "value" + "</N>" * 130,
        "<DOCUMENT><TABLE><TR><TD>" + "x" * 16385 + "</TD></TR></TABLE></DOCUMENT>",
    ]:
        with pytest.raises(OpenDartPayloadError) as caught:
            canonicalize_tables(xml, "bounded.xml")
        assert caught.value.code == "XML_COMPLEXITY_LIMIT"
    with pytest.raises(OpenDartPayloadError):
        canonicalize_tables(
            "<TABLE><TR><TD>a</TD><TD>b</TD></TR></TABLE>", "shared.xml", {"expandedCells": 1999999}
        )


def test_xml_repair_is_bounded_and_audited():
    xml = "<DOCUMENT><P>" + "padding " * 20 + "A & B &amp; C</P></DOCUMENT>"
    normalized = normalize_xml(xml, "source.xml", "source-hash")
    assert normalized["xml"].endswith("A &amp; B &amp; C</P></DOCUMENT>")
    assert normalized["audit"]["repairCounts"]["BARE_AMPERSAND"] == 1
    assert normalized["audit"]["status"] == "NORMALIZED"
    assert merge_candidate_errors([], [normalized["audit"]])[0]["recovered"] is True
    valid = "<DOCUMENT><P>valid &amp; <![CDATA[<source>]]></P><!-- keep --><OTHER/></DOCUMENT>"
    assert normalize_xml(valid)["xml"] == valid
    quote = (
        '<DOCUMENT><TABLE><TR><TD ENG="A sample "projected revenue" statement.'
        + " annotation" * 20
        + '">text</TD></TR></TABLE></DOCUMENT>'
    )
    assert normalize_xml(quote)["audit"]["repairCounts"]["ATTRIBUTE_QUOTE"] == 2
    unknown = "<DOCUMENT><P>" + "padding " * 20 + "&unknown;</P></DOCUMENT>"
    assert normalize_xml(unknown)["xml"] == unknown
    with pytest.raises(OpenDartPayloadError):
        normalize_xml("<DOCUMENT><P>broken</TD></DOCUMENT>")


def test_candidate_recovery_and_all_errors_remain_visible():
    parsed = parse_disclosure(
        archive(
            {
                "00-bad.xml": "<DOCUMENT><P>bad</TD></DOCUMENT>",
                "10-good.xml": (FIXTURES / "d002.xml").read_bytes(),
            }
        ),
        "D002",
    )
    assert parsed["source"]["selectedEntryName"] == "10-good.xml"
    assert parsed["source"]["candidateErrors"][0]["candidateName"] == "00-bad.xml"
    assert parsed["source"]["candidateErrors"][0]["candidateSha256"]


def test_typed_headers_units_duplicate_rows_and_corrections():
    headers = '<TR><TH ROWSPAN="2">보고사유</TH><TH ROWSPAN="2">변동일*</TH><TH ROWSPAN="2">특정증권등의 종류</TH><TH COLSPAN="3">소유주식수(주)</TH><TH ROWSPAN="2">취득/처분단가(원)**</TH></TR><TR><TH>변동전</TH><TH>증감</TH><TH>변동후</TH></TR>'
    row = "<TR><TU>장내매수</TU><TU>2026-09-01</TU><TU>보통주</TU><TU>100</TU><TU>20</TU><TU>120</TU><TU>3000</TU></TR>"
    xml = (
        "<DOCUMENT><CORRECTION><TABLE>"
        + headers
        + row
        + "</TABLE></CORRECTION><TABLE>"
        + headers
        + row
        + row
        + "</TABLE></DOCUMENT>"
    )
    result = extract_trading(canonicalize_tables(xml, "typed.xml")["tables"], "D002")
    assert len(result["transactions"]) == 2
    assert result["transactions"][0]["quantity"] == "20"
    assert result["transactions"][0]["sharesAfter"] == "120"
    assert result["transactions"][0]["provenance"]["quantity"]["headerPath"] == [
        "소유주식수(주)",
        "증감",
    ]
    scaled = "<DOCUMENT><TABLE><TR><TH>변동일</TH><TH>증권의 종류</TH><TH>취득/처분방법</TH><TH>증감수량(천주)</TH><TH>주당거래단가(천원)</TH></TR><TR><TD>2026-09-01</TD><TD>보통주</TD><TD>장내매수</TD><TD>2</TD><TD>3</TD></TR></TABLE></DOCUMENT>"
    value = parse_disclosure(archive({"scaled.xml": scaled}), "D002")["transactions"][0]
    assert (value["quantity"], value["unitPrice"], value["amount"]) == ("2000", "3000", "6000000")


def test_classification_never_uses_query_filter_as_evidence():
    assert classify_filing("알 수 없는 문서", query_detail_type="D005")["canonicalType"] is None
    assert (
        classify_filing("임원ㆍ주요주주특정증권등소유상황보고서", query_detail_type="D005")[
            "canonicalType"
        ]
        == "D002"
    )
    assert (
        classify_filing("공개매수신고서", source_detail_type="D002")["classificationStatus"]
        == "CONFLICT"
    )
    assert not crosscheck_allows_projection(
        "D002", {"status": "OK", "exactReceiptMatches": [{"rcept_no": "other"}]}, "receipt"
    )
    assert crosscheck_allows_projection(
        "D003", {"status": "NOT_APPLICABLE", "reason": "NO_SUMMARY_API_FOR_D003"}, "receipt"
    )
    assert reuse_fingerprint("a", "p", "n", "c", "D001") != reuse_fingerprint(
        "a", "p", "n", "c", "D002"
    )


def test_persisted_audit_rejects_overflow_missing_fields_and_invalid_dates():
    for mutation in [
        lambda p: p["transactions"][0].update(quantity="9" * 33),
        lambda p: p["transactions"][0].update(eventDate="2026-02-30"),
        lambda p: p["transactions"][0].pop("methodRaw"),
    ]:
        parsed = fixture_parse()
        mutation(parsed)
        with pytest.raises(OpenDartPayloadError):
            validate_persisted(parsed)


def test_ai_bound_leases_and_rearm_preserve_delivery_generations():
    parsed = fixture_parse()
    row = parsed["transactions"][0]
    parsed["transactions"] = [{**row, "rowIndex": i, "nature": "UNKNOWN"} for i in range(20)]
    selection = select_candidates(parsed)
    assert len(selection["candidates"]) == 16 and selection["truncated"]
    assert aggregate_classification([{"result": "AI_CONFIRMED"}], True) == "REVIEW_REQUIRED"
    assert processing_lease_ms(1000, 1) == 1800000
    now = datetime.now(UTC)
    assert claim_decision("PROCESSING", now, now, 1000) == "IN_FLIGHT"
    assert claim_decision("PROCESSING", now - timedelta(seconds=2), now, 1000) == "CLAIM"
    outbox = {
        "status": "COMPLETED",
        "updatedAt": now,
        "payloadJson": {"aiReviewRearm": {"count": 2}},
    }
    decision = rearm_plan(outbox, None, now, 1000)
    assert decision["count"] == 3 and decision["availableAt"] == now + timedelta(minutes=30)
    outbox["payloadJson"]["aiReviewRearm"]["count"] = 3
    assert rearm_plan(outbox, None, now, 1000) is None
    assert not confirmed({"reviewDecision": "REJECTED", "source": "MANUAL", "confirmedAt": now})
    assert canonical_integer("100.000000") == "100"
    assert reporter_key("확인 필요") is None


def test_sec_preserves_decimal_text_and_footnote_provenance():
    xml = """<ownershipDocument><documentType>4</documentType><periodOfReport>2026-09-01</periodOfReport><issuer><issuerCik>12345</issuerCik><issuerName>Example</issuerName><issuerTradingSymbol>EXM</issuerTradingSymbol></issuer><reportingOwner><reportingOwnerId><rptOwnerName>Owner</rptOwnerName></reportingOwnerId><reportingOwnerRelationship><isOfficer>1</isOfficer></reportingOwnerRelationship></reportingOwner><nonDerivativeTable><nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle><transactionCoding><transactionCode>P</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>9007199254740993.125000</value><footnoteId id="F1"/></transactionShares><transactionPricePerShare><value>0.000001</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts></nonDerivativeTransaction></nonDerivativeTable><footnotes><footnote id="F1">Reported source value</footnote></footnotes></ownershipDocument>"""
    provenance = {
        "accessionNumber": "0000012345-26-000001",
        "expectedCik": "0000012345",
        "filingDate": "2026-09-02",
        "acceptanceDateTime": None,
        "sourceUrl": "https://www.sec.gov/Archives/edgar/data/12345/000001234526000001/ownership.xml",
    }
    result = parse_ownership(xml, provenance)
    assert result["transactions"][0]["transactionShares"] == "9007199254740993.125000"
    assert result["transactions"][0]["derivedTransactionKind"] == "OPEN_MARKET_OR_PRIVATE_PURCHASE"
    assert result["transactions"][0]["footnoteReferences"] == ["F1"]
    assert result["unresolvedFootnoteReferences"] == []
    assert result["reportingOwners"][0]["isOfficer"] is True
    literal = parse_ownership(
        xml.replace("Reported source value", "&nbsp; source value"), provenance
    )
    assert literal["footnotes"][0]["text"] == "&nbsp; source value"
    source = {
        "externalId": provenance["accessionNumber"],
        "rawMetadataJson": {"cik": provenance["expectedCik"]},
        "url": provenance["sourceUrl"].replace("ownership.xml", "xslF345X05/ownership.xml"),
    }
    assert ownership_url(source) == provenance["sourceUrl"]
    for url in [
        "https://evil.example/ownership.xml",
        provenance["sourceUrl"] + "?download=1",
        provenance["sourceUrl"].replace("ownership.xml", "%2e%2e/ownership.xml"),
    ]:
        with pytest.raises(ValueError):
            ownership_url({**source, "url": url})


def test_meeting_time_preserves_kst_as_utc_instant():
    assert (
        meeting_instant("2026-09-10", "2026년 9월 10일 오후 2시 30분")["meetingAt"]
        == "2026-09-10T05:30:00.000Z"
    )
    assert meeting_instant("2026-09-10", "오후 14시")["meetingAt"] is None


def narrative_fixture(name, kind):
    return parse_disclosure(archive({"report.xml": (FIXTURES / name).read_bytes()}), kind)


def test_proxy_solicitation_preserves_ballot_agendas_and_kst_instant():
    parsed = narrative_fixture("d003.xml", "D003")
    assert parsed["solicitorName"] == "외부주주"
    assert parsed["targetCompanyName"] == "대상회사"
    assert parsed["electronicVoting"] is True
    assert parsed["meetingAt"] == "2026-09-22T00:30:00.000Z"
    assert parsed["meetingDate"] == "2026-09-22"
    assert [(row["ordinal"], row["title"]) for row in parsed["agendas"]] == [
        (1, "정관의 변경"),
        (2, "이사 선임"),
    ]
    assert "transactions" not in parsed
    validate_persisted(parsed)


def test_tender_report_keeps_planned_quantities_separate_from_completed_purchases():
    parsed = narrative_fixture("d004-report.xml", "D004")
    assert parsed["documentKind"] == "REPORT"
    assert parsed["offerorName"] == "매수회사"
    assert (
        parsed["subscriptionStartDate"],
        parsed["subscriptionEndDate"],
        parsed["settlementDate"],
    ) == ("2026-07-20", "2026-09-17", "2026-09-21")
    security = parsed["securities"][0]
    expected = {
        "unitPrice": "48000",
        "currency": "KRW",
        "minQuantity": "3000",
        "maxQuantity": "9000",
        "heldQuantity": "2000",
        "expectedHoldingsMin": "5000",
        "expectedHoldingsMax": "11000",
        "offeredQuantity": None,
        "acquiredQuantity": None,
    }
    assert {field: security[field] for field in expected} == expected
    validate_persisted(parsed)


def test_verified_tender_result_preserves_actual_quantity_and_exact_amount():
    parsed = narrative_fixture("d004-result.xml", "D004")
    assert parsed["documentKind"] == "RESULT" and parsed["confidence"] == 0.95
    assert parsed["offerorName"] == "결과보고자" and parsed["warnings"] == []
    security = parsed["securities"][0]
    assert (
        security["offeredQuantity"],
        security["acquiredQuantity"],
        security["actualAmount"],
    ) == ("100", "90", "603000")
    validate_persisted(parsed)


def test_unverified_tender_result_layout_never_invents_acquired_quantities():
    xml = "<DOCUMENT><DOCUMENT-NAME>공개매수결과보고서</DOCUMENT-NAME><COMPANY-NAME>대상</COMPANY-NAME><BODY><TABLE><TR><TD>공개매수 대상회사명</TD><TD>대상</TD></TR><TR><TD>공개매수 목적</TD><TD>목적</TD></TR><TR><TD>공개매수기간</TD><TD>2026.01.01.-2026.01.02.</TD></TR></TABLE></BODY></DOCUMENT>"
    parsed = parse_disclosure(archive({"report.xml": xml}), "D004")
    assert parsed["securities"] == []
    assert "UNVERIFIED_TENDER_RESULT_TEMPLATE" in {
        warning["code"] for warning in parsed["warnings"]
    }


def test_undeclared_named_entities_remain_literal_without_source_repair_or_resolution():
    xml = '<DOCUMENT><TABLE><TR><TD ENG="A &nbsp; B">A &nbsp; &unknown; &amp;nbsp; &#65; B</TD></TR></TABLE></DOCUMENT>'
    normal = normalize_xml(xml)
    assert normal["xml"] == xml and normal["audit"]["status"] == "UNCHANGED"
    tables = canonicalize_tables(xml, "synthetic.xml")
    cell = tables["tables"][0]["sourceRows"][0][0]
    assert cell["rawText"] == "A &nbsp; &unknown; &amp;nbsp; &#65; B"
    assert cell["text"] == "A &nbsp; &unknown; &nbsp; A B"
    assert cell["attributes"] == {"ENG": "A &nbsp; B"}
    repeated = xml.replace("A &nbsp;", "\ue000 &nbsp;")
    assert canonicalize_tables(repeated, "synthetic.xml")["tables"][0]["rows"][0][0].startswith(
        "\ue000 &nbsp;"
    )
