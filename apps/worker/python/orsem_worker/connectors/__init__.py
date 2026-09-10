"""Native metadata connectors. Registration never performs network I/O."""

from .classifier import Classifier
from .common import public_url
from .discovery import Discovery
from .feeds import FeedConnector
from .health import Health
from .policy import RSS_FEEDS, ir_profile
from .sec_access import SecHttp
from .translation import TranslationService


async def register(ctx):
    for feed in ctx.config.newsRssFeeds:
        if feed not in RSS_FEEDS:
            raise ValueError("NEWS_RSS_FEEDS contains an unregistered feed ID.")
    for url in ctx.config.irFeedUrls:
        profile = ir_profile(url)
        if profile is None:
            raise ValueError("IR_FEED_URLS contains an unregistered feed URL.")
        public_url(url, https=True, allowed_hosts=profile["allowedHosts"])
    if len(ctx.config.irFeedUrls) > 100:
        raise ValueError("IR feed limit exceeded.")
    # Eager registry validation; disabled profiles remain inert.
    FeedConnector(ctx, "NEWS_RSS", ctx.config.newsRssFeeds)
    FeedConnector(ctx, "IR", ctx.config.irFeedUrls)
    ctx.services["sec_http"] = SecHttp(ctx)
    ctx.services["classifier"] = Classifier(ctx)
    discovery = Discovery(ctx)
    health, translation = Health(ctx, discovery), TranslationService(ctx)
    ctx.services.update(
        news_discovery=discovery, connector_health=health, news_translation=translation
    )
    return {
        "discover-news-links": discovery.discover,
        "check-connectors": health.check_all,
        "translate-news-batch": translation.translate_batch,
    }
