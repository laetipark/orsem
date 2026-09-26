"""The metadata translator may contact only the approved private Ollama origin."""

import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx

from orsem_worker.connectors import translation


def client(url="http://172.30.1.99:11434", model="qwen3.5:4b-q4_K_M"):
    config = SimpleNamespace(
        newsTranslationEnabled=True,
        ollamaUrl=url,
        newsTranslationModel=model,
        newsTranslationTimeoutMs=120000,
    )
    return translation.LocalTranslationClient(SimpleNamespace(config=config))


INPUT = {"title": "Example title", "description": None, "tickers": []}


class TranslationOriginTests(unittest.IsolatedAsyncioTestCase):
    def test_input_excludes_article_body_images_and_naver_results(self):
        source = {
            "source": "NEWS_RSS",
            "title": "ABC earnings outlook remains uncertain",
            "rights_mode": "PRIVATE_DISPLAY_ONLY",
            "source_policy_json": {
                "rightsMode": "PRIVATE_DISPLAY_ONLY",
                "metadataStorageAllowed": True,
                "displayAllowed": True,
                "aiAllowed": True,
            },
            "body": "Do not send this article body.",
            "image": "Do not send this image.",
        }
        news = {
            "description": "Approved publisher summary.",
            "tickers_json": ["ABC"],
            "body": "Do not send this article body.",
            "image_url": "Do not send this image.",
            "naver_results": "Do not send search results.",
        }
        self.assertEqual(
            translation.translation_input(source, news),
            {
                "title": source["title"],
                "description": news["description"],
                "tickers": ["ABC"],
            },
        )
        source["source"] = "NAVER"
        self.assertIsNone(translation.translation_input(source, news))

    async def test_approved_origin_uses_only_model_inspection_and_chat(self):
        responses = [
            httpx.Response(200, json={"details": {"format": "gguf"}}),
            httpx.Response(
                200,
                json={
                    "done": True,
                    "done_reason": "stop",
                    "message": {"content": '{"title":"예시 제목","description":null}'},
                },
            ),
        ]
        with patch.object(translation, "request_bytes", new_callable=AsyncMock) as request:
            request.side_effect = responses
            with patch.object(translation, "validate_translation", return_value={}) as validate:
                await client().translate(INPUT)
            self.assertEqual(
                [call.args[1] for call in request.await_args_list],
                [
                    "http://172.30.1.99:11434/api/show",
                    "http://172.30.1.99:11434/api/chat",
                ],
            )
            self.assertEqual(request.await_args.kwargs["timeout_ms"], 120000)
            self.assertEqual(
                json.loads(request.await_args.kwargs["json_body"]["messages"][1]["content"]),
                INPUT,
            )
            validate.assert_called_once()

    async def test_rejects_any_other_origin_before_network(self):
        urls = (
            "http://127.0.0.1:11434",
            "http://localhost:11434",
            "http://[::1]:11434",
            "http://172.30.1.98:11434",
            "http://172.30.1.99:11435",
            "http://172.30.1.99",
            "https://172.30.1.99:11434",
            "http://user:pass@172.30.1.99:11434",
            "http://172.30.1.99:11434/",
            "http://172.30.1.99:11434/api/chat",
            "http://172.30.1.99:11434?x=1",
            "http://172.30.1.99:11434#fragment",
        )
        for url in urls:
            with self.subTest(url=url), patch.object(
                translation, "request_bytes", new_callable=AsyncMock
            ) as request:
                with self.assertRaisesRegex(ValueError, "approved Ollama HTTP origin"):
                    await client(url).translate(INPUT)
                request.assert_not_awaited()

    async def test_rejects_remote_model_tags_before_network(self):
        for model in ("qwen3.5:4b-cloud", "provider/cloud", "cloud"):
            with self.subTest(model=model), patch.object(
                translation, "request_bytes", new_callable=AsyncMock
            ) as request:
                with self.assertRaisesRegex(ValueError, "locally installed model"):
                    await client(model=model).translate(INPUT)
                request.assert_not_awaited()

    async def test_rejects_remote_model_metadata(self):
        response = httpx.Response(
            200, json={"remote_host": "remote.example", "details": {"format": "gguf"}}
        )
        with patch.object(translation, "request_bytes", new_callable=AsyncMock) as request:
            request.return_value = response
            with self.assertRaisesRegex(ValueError, "Remote model execution"):
                await client().translate(INPUT)
            self.assertEqual(request.await_count, 1)
            self.assertEqual(request.await_args.kwargs["json_body"], {"model": "qwen3.5:4b-q4_K_M"})
