"""OpenAI-compatible classification suggestions; deterministic facts remain authoritative."""

import json
from pathlib import Path
from urllib.parse import urljoin

from orsem_worker.core import json_text, sha256

from .common import iso, request_bytes

CONTRACT = json.loads(Path(__file__).with_name("classifier_contract.json").read_text())
AI_CLASSIFIER_PROMPT_VERSION = CONTRACT["AI_CLASSIFIER_PROMPT_VERSION"]
AI_CLASSIFIER_PROMPT_HASH = CONTRACT["AI_CLASSIFIER_PROMPT_HASH"]
AI_CLASSIFIER_SYSTEM_PROMPT = CONTRACT["AI_CLASSIFIER_SYSTEM_PROMPT"]
AI_CLASSIFIER_OUTPUT_JSON_SCHEMA = CONTRACT["AI_CLASSIFIER_OUTPUT_JSON_SCHEMA"]


def validate_output(value):
    schema = AI_CLASSIFIER_OUTPUT_JSON_SCHEMA
    if not isinstance(value, dict) or set(value) != set(schema["required"]):
        raise ValueError("AI output failed schema validation.")
    for key in ("nature", "direction"):
        if value[key] not in schema["properties"][key]["enum"]:
            raise ValueError("AI output failed schema validation.")
    if (
        isinstance(value["confidence"], bool)
        or not isinstance(value["confidence"], (int, float))
        or not 0 <= value["confidence"] <= 1
    ):
        raise ValueError("AI output failed schema validation.")
    if not isinstance(value["rationale"], str) or not 1 <= len(value["rationale"]) <= 500:
        raise ValueError("AI output failed schema validation.")
    if (
        not isinstance(value["evidence"], list)
        or len(value["evidence"]) > 8
        or any(not isinstance(v, str) or not 1 <= len(v) <= 200 for v in value["evidence"])
    ):
        raise ValueError("AI output failed schema validation.")
    return value


def review_suggestion(output, source_fragments, deterministic_direction, deterministic_nature):
    output = validate_output(output)
    reasons = []
    if not output["evidence"]:
        reasons.append("AI did not cite any source evidence.")
    if any(
        not any(evidence in source for source in source_fragments)
        for evidence in output["evidence"]
    ):
        reasons.append("AI evidence is not a verbatim fragment of the supplied source.")
    if deterministic_direction != "UNKNOWN" and output["direction"] != deterministic_direction:
        reasons.append("AI direction conflicts with the deterministic quantity direction.")
    if (
        output["nature"] in ("MARKET_BUY", "MARKET_SELL", "BLOCK_BUY", "BLOCK_SELL")
        and output["nature"] != deterministic_nature
    ):
        reasons.append("AI cannot upgrade an unknown method into a market transaction.")
    if output["confidence"] < 0.9:
        reasons.append("AI confidence is below the review threshold.")
    if output["nature"] == "UNKNOWN" or output["direction"] == "UNKNOWN":
        reasons.append("AI output must resolve both nature and direction.")
    if reasons:
        return {"result": "REVIEW_REQUIRED", "suggestion": output, "reasons": reasons}
    return {
        "result": "AI_CONFIRMED"
        if output["nature"] == deterministic_nature
        and output["direction"] == deterministic_direction
        else "AI_SUGGESTED",
        "suggestion": output,
        "reasons": ["Human review is required before applying any AI suggestion."],
    }


class Classifier:
    def __init__(self, ctx):
        self.ctx, self.config = ctx, ctx.config

    @property
    def enabled(self):
        return bool(self.config.aiEnabled and self.config.aiModel and self.config.aiBaseUrl)

    def headers(self):
        return {
            "Content-Type": "application/json",
            **({"Authorization": f"Bearer {self.config.aiApiKey}"} if self.config.aiApiKey else {}),
        }

    async def probe_health(self):
        result = {
            "status": "UNCONFIGURED",
            "message": "AI classifier is disabled or unconfigured.",
            "checkedAt": iso(),
            "enabled": False,
            "configuredModelPresent": None,
        }
        if not self.enabled:
            return result
        result["enabled"] = True
        result["status"] = "DEGRADED"
        try:
            response = await request_bytes(
                self.ctx,
                urljoin(self.config.aiBaseUrl.rstrip("/") + "/", "models"),
                headers=self.headers(),
                timeout_ms=5000,
                max_bytes=65536,
            )
            if not response.is_success:
                result["message"] = f"AI model probe returned HTTP {response.status_code}."
                return result
            models = response.json()["data"]
            if (
                not isinstance(models, list)
                or len(models) > 10000
                or any(
                    not isinstance(m, dict)
                    or not isinstance(m.get("id"), str)
                    or not 1 <= len(m["id"]) <= 512
                    for m in models
                )
            ):
                raise ValueError("Invalid models")
            present = any(m["id"] == self.config.aiModel for m in models)
            result.update(
                status="HEALTHY" if present else "DEGRADED",
                message=None
                if present
                else "Configured AI model is not available from the endpoint.",
                configuredModelPresent=present,
            )
        except TimeoutError:
            result["message"] = "AI model probe timed out."
        except Exception:  # noqa: BLE001 - safe per-provider/document boundary; preserve diagnostics without source or credentials
            result["message"] = "AI model probe returned an invalid or unavailable response."
        return result

    async def suggest(self, input):
        canonical = {
            k: input.get(k)
            for k in (
                "methodRaw",
                "securityTypeRaw",
                "quantity",
                "deterministicNature",
                "deterministicDirection",
            )
        }
        audit = {
            "inputHash": sha256(json_text(canonical)),
            "model": self.config.aiModel,
            "promptHash": AI_CLASSIFIER_PROMPT_HASH,
            "promptVersion": AI_CLASSIFIER_PROMPT_VERSION,
            "rawOutput": None,
            "evidenceRefs": [],
        }

        def failure(message):
            return {
                "result": "REVIEW_REQUIRED",
                "suggestion": None,
                "reasons": [message],
                "audit": audit,
            }

        if not self.enabled:
            return failure("AI classifier is disabled or unconfigured.")
        fragments = [input[k] for k in ("methodRaw", "securityTypeRaw") if input.get(k)]
        body = {
            "model": self.config.aiModel,
            "temperature": 0,
            "reasoning_effort": "none",
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "orsem_transaction_classification_review",
                    "strict": True,
                    "schema": AI_CLASSIFIER_OUTPUT_JSON_SCHEMA,
                },
            },
            "messages": [
                {"role": "system", "content": AI_CLASSIFIER_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": json_text(
                        {
                            "methodRaw": input["methodRaw"],
                            "securityTypeRaw": input["securityTypeRaw"],
                            "quantity": input.get("quantity"),
                            "deterministicCandidates": {
                                "nature": input["deterministicNature"],
                                "direction": input["deterministicDirection"],
                            },
                            "promptVersion": AI_CLASSIFIER_PROMPT_VERSION,
                        }
                    ),
                },
            ],
        }
        try:
            response = await request_bytes(
                self.ctx,
                urljoin(self.config.aiBaseUrl.rstrip("/") + "/", "chat/completions"),
                method="POST",
                headers=self.headers(),
                timeout_ms=self.config.aiTimeoutMs,
                max_bytes=65536,
                json_body=body,
            )
            if not response.is_success:
                return failure(f"AI endpoint returned HTTP {response.status_code}.")
            raw = response.content.decode("utf-8", errors="strict")
            audit["rawOutput"] = raw[:20000]
            envelope = json.loads(raw)
            content = envelope["choices"][0]["message"]["content"]
            if not isinstance(content, str):
                raise ValueError("AI output failed schema validation.")  # noqa: TRY004 - preserve the deployed provider validation exception contract
            audit["rawOutput"] = content[:20000]
            output = validate_output(json.loads(content))
            review = review_suggestion(
                output, fragments, input["deterministicDirection"], input["deterministicNature"]
            )
            audit["evidenceRefs"] = [
                f"{next(i for i, f in enumerate(fragments) if e in f)}:{sha256(e)}"
                for e in output["evidence"]
                if any(e in f for f in fragments)
            ]
            return {**review, "audit": audit}
        except json.JSONDecodeError:
            return failure("AI endpoint returned invalid JSON.")
        except TimeoutError:
            return failure("AI endpoint timed out.")
        except (ValueError, KeyError, IndexError, TypeError):
            return failure("AI output failed schema validation.")
        except Exception:  # noqa: BLE001 - safe per-provider/document boundary; preserve diagnostics without source or credentials
            return failure("AI review request failed safely.")

    classify = suggest
    probeHealth = probe_health
