import asyncio
import logging


class _MysqlCompatibilityWarningFilter(logging.Filter):
    def filter(self, record):
        # MySQL emits this advisory once per row for compatible upserts. Keep
        # every other warning/error visible without filling operational logs.
        return "'VALUES function' is deprecated" not in record.getMessage()


def main():
    from .runtime import run

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    logging.getLogger("asyncmy").addFilter(_MysqlCompatibilityWarningFilter())
    # External client loggers can otherwise expose credential-bearing provider URLs.
    for name in ("httpx", "httpcore", "websockets", "sqlalchemy.engine"):
        logging.getLogger(name).setLevel(logging.CRITICAL)
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
    except Exception as error:  # noqa: BLE001 - isolate jobs and redact provider credentials
        logging.getLogger("orsem.worker").critical(
            "Worker startup or shutdown failed (%s).", type(error).__name__
        )
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
