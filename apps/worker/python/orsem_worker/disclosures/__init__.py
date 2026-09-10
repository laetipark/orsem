"""OpenDART collection/parsing and SEC ownership worker registration."""


async def register(ctx):
    from .ai_review import DisclosureAiReview
    from .client import OpenDartClient
    from .deferred import DeferredProjection
    from .enrichment import FilingEnrichment
    from .health import OpenDartHealth
    from .ingestion import OpenDartIngestion
    from .sec import SecOwnershipService

    client = OpenDartClient(ctx)
    health = OpenDartHealth(ctx, client)
    ingestion = OpenDartIngestion(ctx, client)
    enrichment = FilingEnrichment(ctx, client, health)
    ai = DisclosureAiReview(ctx)
    deferred = DeferredProjection(ctx, enrichment)
    ctx.services.update(
        {
            "opendart": client,
            "opendart_health": health,
            "opendart_ingestion": ingestion,
            "enrichment": enrichment,
            "disclosure_ai": ai,
            "deferred_projection": deferred,
            "sec_ownership": SecOwnershipService(ctx),
        }
    )
    return {
        "poll-opendart": ingestion.poll,
        "backfill-opendart": ingestion.poll,
        "sync-opendart-corp-codes": ingestion.sync_corp_codes,
        "enrich-filing": enrichment.enrich,
        "apply-parse-projection": deferred.apply,
        "review-parse-with-ai": ai.review,
    }
