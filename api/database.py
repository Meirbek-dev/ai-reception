from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator
from dataclasses import dataclass
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from config import settings


class Base(DeclarativeBase):
    """Base class for SQLAlchemy models."""


@dataclass
class _DatabaseState:
    engine: AsyncEngine | None = None
    session_factory: async_sessionmaker[AsyncSession] | None = None


_state = _DatabaseState()


def _alembic_config() -> Config:
    module_dir = Path(__file__).resolve().parent
    cfg_path = module_dir / "alembic.ini"
    script_location = module_dir / "migrations"
    if not script_location.exists():
        script_location = module_dir / "alembic"
    config = Config(str(cfg_path))
    config.set_main_option("script_location", str(script_location))
    config.set_main_option("sqlalchemy.url", settings.database_url)
    config.attributes["configure_logger"] = False
    return config


def _ensure_sqlite_path(url: str) -> None:
    sa_url = make_url(url)
    if sa_url.get_backend_name() != "sqlite":
        return
    database = sa_url.database
    if not database:
        return
    path = Path(database)
    if not path.is_absolute():
        path = Path.cwd() / path
    path.parent.mkdir(parents=True, exist_ok=True)


def init_engine() -> None:
    """Initialise the global async engine and session factory."""
    if _state.engine is not None:
        return

    _ensure_sqlite_path(settings.database_url)
    engine = create_async_engine(settings.database_url, future=True)
    session_factory = async_sessionmaker(
        engine,
        expire_on_commit=False,
        autoflush=False,
    )
    _state.engine = engine
    _state.session_factory = session_factory


def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    if _state.session_factory is None:
        msg = "Database engine has not been initialised"
        raise RuntimeError(msg)
    return _state.session_factory


async def get_session() -> AsyncGenerator[AsyncSession]:
    sessionmaker = get_sessionmaker()
    async with sessionmaker() as session:
        yield session


async def close_engine() -> None:
    if _state.engine is not None:
        await _state.engine.dispose()
    _state.engine = None
    _state.session_factory = None


async def run_migrations() -> None:
    """Apply Alembic migrations up to head."""
    _ensure_sqlite_path(settings.database_url)
    config = _alembic_config()
    await asyncio.to_thread(command.upgrade, config, "head")
