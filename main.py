"""
main.py  —  Vendora CLI Entrypoint

Usage:
  python main.py setup          — Create DB tables + seed taxonomy + sample vendors
  python main.py api            — Start the FastAPI REST API (port 8000)
  python main.py discover       — Run Google Places discovery sweep (Tier 1 states)
  python main.py discover-yelp  — Run Yelp Fusion discovery sweep
  python main.py consume        — Start Redis stream consumer (continuous)
  python main.py score          — Score all unscored vendors
  python main.py classify       — Classify unclassified vendors
  python main.py dedup          — Run dedup batch
  python main.py status         — Print pipeline status to console
  python main.py reset          — Drop and recreate all tables (DESTRUCTIVE)
"""

import asyncio
import logging
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

import click
from rich.console import Console
from rich.table import Table
from rich.panel import Panel

from config import settings

console = Console()
logging.basicConfig(
    level=getattr(logging, settings.LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


@click.group()
def cli():
    """Vendora — LeaseLoft Vendor Acquisition Engine CLI"""
    pass


@cli.command()
@click.option("--with-samples/--no-samples", default=True, help="Seed sample vendor data")
def setup(with_samples: bool):
    """Create database tables, seed taxonomy, and optionally add sample vendors."""
    console.print(Panel("[bold cyan]Vendora — Setup[/bold cyan]"))

    console.print("[yellow]1. Connecting to PostgreSQL...[/yellow]")
    from db.connection import create_all_tables
    try:
        create_all_tables()
        console.print("[green]\u2713 Database tables created[/green]")
    except Exception as e:
        console.print(f"[red]\u2717 Database error: {e}[/red]")
        console.print("[dim]Make sure PostgreSQL is running and DATABASE_URL in .env is correct.[/dim]")
        return

    console.print("[yellow]2. Seeding taxonomy...[/yellow]")
    from db.connection import get_db
    from db.seed import seed_taxonomy
    with get_db() as db:
        n = seed_taxonomy(db)
        console.print(f"[green]\u2713 Taxonomy seeded: {n} categories[/green]")

    if with_samples:
        console.print("[yellow]3. Seeding sample vendors...[/yellow]")
        from db.seed import seed_sample_vendors
        with get_db() as db:
            n = seed_sample_vendors(db)
            console.print(f"[green]\u2713 Sample vendors seeded: {n} vendors[/green]")

    console.print("\n[bold green]\u2713 Setup complete![/bold green]")
    console.print("[dim]Run 'python main.py api' to start the REST API.[/dim]")
    console.print("[dim]Run 'python main.py status' to view pipeline stats.[/dim]")


@cli.command()
@click.option("--host", default=settings.API_HOST)
@click.option("--port", default=settings.API_PORT, type=int)
@click.option("--reload/--no-reload", default=(settings.APP_ENV == "development"))
def api(host: str, port: int, reload: bool):
    """Start the FastAPI REST API server."""
    console.print(Panel(f"[bold cyan]Starting API at http://{host}:{port}[/bold cyan]"))
    console.print(f"[dim]Docs: http://{host}:{port}/docs[/dim]")
    import uvicorn
    uvicorn.run("api.main:app", host=host, port=port, reload=reload,
                log_level=settings.LOG_LEVEL.lower())


@cli.command()
@click.option("--tier", default=1, type=int, help="Market tier (1=Tier1 states)")
@click.option("--max-records", default=None, type=int)
@click.option("--dry-run/--no-dry-run", default=False)
def discover(tier: int, max_records, dry_run: bool):
    """Run Google Places vendor discovery sweep."""
    if not settings.GOOGLE_PLACES_API_KEY:
        console.print("[red]\u2717 GOOGLE_PLACES_API_KEY not set in .env[/red]")
        return
    console.print(Panel(f"[bold cyan]Google Places Discovery — Tier {tier}[/bold cyan]"))
    if dry_run: console.print("[yellow]DRY RUN: records will not be emitted to Redis[/yellow]")

    async def _run():
        import redis.asyncio as aioredis
        r = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
        from agents.discovery_google import GooglePlacesDiscoveryAgent
        agent = GooglePlacesDiscoveryAgent(api_key=settings.GOOGLE_PLACES_API_KEY, redis_client=r,
                                           tier=tier, dry_run=dry_run)
        stats = await agent.run_sweep(max_records=max_records)
        await r.aclose()
        return stats

    stats = asyncio.run(_run())
    table = Table(title="Discovery Results")
    table.add_column("Metric", style="cyan")
    table.add_column("Value", style="green")
    for k, v in stats.items(): table.add_row(k.replace("_", " ").title(), str(v))
    console.print(table)


@cli.command(name="discover-yelp")
@click.option("--max-records", default=100, type=int)
@click.option("--dry-run/--no-dry-run", default=False)
def discover_yelp(max_records: int, dry_run: bool):
    """Run Yelp Fusion discovery sweep for Tier 1 DMAs."""
    if not settings.YELP_API_KEY:
        console.print("[red]\u2717 YELP_API_KEY not set in .env[/red]")
        return
    console.print(Panel("[bold cyan]Yelp Fusion Discovery[/bold cyan]"))

    async def _run():
        import redis.asyncio as aioredis
        r = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
        from agents.discovery_yelp_angi import YelpFusionDiscoveryAgent
        agent = YelpFusionDiscoveryAgent(api_key=settings.YELP_API_KEY, redis_client=r, dry_run=dry_run)
        stats = await agent.run_sweep(max_records=max_records)
        await r.aclose()
        return stats

    stats = asyncio.run(_run())
    console.print(f"[green]Yelp discovery complete: {stats}[/green]")


@cli.command()
@click.option("--batch-size", default=50, type=int)
@click.option("--once/--forever", default=False, help="Process one batch then exit")
def consume(batch_size: int, once: bool):
    """Consume Redis streams and persist vendors to PostgreSQL."""
    console.print(Panel("[bold cyan]Stream Consumer[/bold cyan]"))
    from agents.stream_consumer import StreamConsumer
    consumer = StreamConsumer()
    if once:
        stats = consumer.consume_batch(batch_size=batch_size)
        console.print(f"[green]Batch complete: {stats}[/green]")
    else:
        console.print("[dim]Running continuously... Ctrl+C to stop[/dim]")
        consumer.run_forever(batch_size=batch_size)


@cli.command()
@click.option("--limit", default=500, type=int)
def score(limit: int):
    """Score all unscored or stale vendors."""
    console.print(Panel("[bold cyan]Scoring Agent[/bold cyan]"))
    from db.connection import get_db
    from agents.scoring import ScoringAgent
    with get_db() as db:
        stats = ScoringAgent(db).run_batch(limit=limit, trigger_event="cli_manual")
    table = Table(title="Scoring Results")
    table.add_column("Metric", style="cyan")
    table.add_column("Value", style="green")
    for k, v in stats.items(): table.add_row(str(k), str(v))
    console.print(table)


@cli.command()
@click.option("--limit", default=200, type=int)
def classify(limit: int):
    """Classify unclassified vendors through the 3-layer classifier."""
    console.print(Panel("[bold cyan]Classification Agent[/bold cyan]"))
    from db.connection import get_db
    from agents.classification import ClassificationAgent
    with get_db() as db:
        stats = ClassificationAgent(db).run_batch(limit=limit)
    console.print(f"[green]Classification complete: {stats}[/green]")


@cli.command()
@click.option("--limit", default=500, type=int)
def dedup(limit: int):
    """Run deduplication on existing vendor records."""
    console.print(Panel("[bold cyan]Deduplication Agent[/bold cyan]"))
    from db.connection import get_db
    from agents.dedup import DedupAgent
    with get_db() as db:
        stats = DedupAgent(db).run_batch(limit=limit)
    console.print(f"[green]Dedup complete: {stats}[/green]")


@cli.command()
def status():
    """Print pipeline status and vendor statistics."""
    console.print(Panel("[bold cyan]Pipeline Status[/bold cyan]"))
    from db.connection import get_db
    from db.models import Vendor, DedupPair
    from sqlalchemy import func, desc

    with get_db() as db:
        total = db.query(func.count(Vendor.vendor_id)).scalar()
        active = db.query(func.count(Vendor.vendor_id)).filter(Vendor.is_active == True).scalar()
        tier_data = (db.query(Vendor.score_tier, func.count(Vendor.vendor_id))
                     .filter(Vendor.is_active == True).group_by(Vendor.score_tier).all())
        cat_data = (db.query(Vendor.primary_category_code, func.count(Vendor.vendor_id))
                    .filter(Vendor.is_active == True).group_by(Vendor.primary_category_code)
                    .order_by(desc(func.count(Vendor.vendor_id))).limit(10).all())
        state_data = (db.query(Vendor.state, func.count(Vendor.vendor_id))
                      .filter(Vendor.is_active == True, Vendor.state != None)
                      .group_by(Vendor.state).order_by(desc(func.count(Vendor.vendor_id))).limit(10).all())
        pending_dedup = db.query(func.count(DedupPair.pair_id)).filter(
            DedupPair.resolution == "pending").scalar()

    summary = Table(title="Vendor Database Summary")
    summary.add_column("Metric", style="cyan")
    summary.add_column("Value", style="bold green")
    summary.add_row("Total Vendors", str(total))
    summary.add_row("Active Vendors", str(active))
    summary.add_row("Pending Dedup Pairs", str(pending_dedup))
    console.print(summary)

    tier_table = Table(title="Score Tier Distribution")
    tier_table.add_column("Tier", style="cyan")
    tier_table.add_column("Label")
    tier_table.add_column("Count", style="green")
    tier_labels = {"A": "Preferred", "B": "Qualified", "C": "Provisional", "D": "Unverified", "F": "Disqualified", None: "Unscored"}
    for tier, count in sorted(tier_data, key=lambda x: (x[0] or "Z")):
        tier_table.add_row(tier or "—", tier_labels.get(tier, ""), str(count))
    console.print(tier_table)

    from taxonomy import CATEGORY_BY_CODE
    cat_table = Table(title="Top 10 Categories")
    cat_table.add_column("Code", style="cyan")
    cat_table.add_column("Name")
    cat_table.add_column("Count", style="green")
    for code, count in cat_data:
        name = CATEGORY_BY_CODE.get(code, {}).get("display_name", code) if code else "—"
        cat_table.add_row(code or "—", name, str(count))
    console.print(cat_table)

    state_table = Table(title="Top 10 States")
    state_table.add_column("State", style="cyan")
    state_table.add_column("Count", style="green")
    for state, count in state_data: state_table.add_row(state or "—", str(count))
    console.print(state_table)


@cli.command()
@click.confirmation_option(prompt="\u26a0\ufe0f  This will DROP all tables. Are you sure?")
def reset():
    """Drop and recreate all tables. DESTRUCTIVE — use only in development."""
    console.print("[red]Dropping all tables...[/red]")
    from db.connection import drop_all_tables, create_all_tables
    drop_all_tables()
    create_all_tables()
    console.print("[green]\u2713 Tables recreated. Run 'python main.py setup' to re-seed.[/green]")


if __name__ == "__main__":
    cli()
