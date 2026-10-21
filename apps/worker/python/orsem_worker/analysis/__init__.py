"""Opt-in disclosure analysis producers and handlers on the existing filing queue."""


async def register(ctx):
    from .service import Analysis
    from .sources import DartGate

    analysis = Analysis(ctx)
    ctx.services["analysis"] = analysis
    if getattr(ctx.config, "analysisEnabled", False):
        ctx.services["analysis_dart_gate"] = DartGate(ctx)
        ctx.periodic("analysis-dispatch", 15, analysis.dispatch)
        ctx.periodic("analysis-auto-refresh", 300, analysis.auto_refresh, immediately=False)
    return {"process-analysis-job": analysis.process}
