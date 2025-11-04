from __future__ import annotations

import argparse
import asyncio
import getpass

import sqlalchemy as sa

from database import (
    close_engine,
    get_sessionmaker,
    init_engine,
    run_migrations,
)
from models import User, UserRole
from security import hash_password


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Management commands for the AI Reception backend",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    create_admin = subparsers.add_parser(
        "create-admin",
        help="Create or update an administrator account",
    )
    create_admin.add_argument(
        "--email", required=True, help="Email address for the user"
    )
    create_admin.add_argument(
        "--password",
        help="Password for the user (leave blank to prompt interactively)",
    )
    create_admin.add_argument(
        "--name",
        dest="display_name",
        help="Display name to associate with the user",
    )
    create_admin.add_argument(
        "--role",
        choices=[role.value for role in UserRole],
        default=UserRole.ADMIN.value,
        help="Role assigned to the user",
    )

    return parser


async def create_admin_user(args: argparse.Namespace) -> None:
    email = args.email.strip().lower()
    if not email:
        msg = "Email must not be blank"
        raise ValueError(msg)

    password = args.password
    if not password:
        password = getpass.getpass("Password: ")
        if not password:
            msg = "Password must not be blank"
            raise ValueError(msg)

    display_name = args.display_name or email.split("@")[0]

    role = UserRole(args.role)
    password_hash = hash_password(password)

    await run_migrations()
    init_engine()
    sessionmaker = get_sessionmaker()

    try:
        async with sessionmaker() as session:
            existing = await session.execute(sa.select(User).where(User.email == email))
            user = existing.scalar_one_or_none()

            if user:
                user.display_name = display_name
                user.role = role
                user.password_hash = password_hash
                message = "Updated existing user"
            else:
                user = User(
                    email=email,
                    display_name=display_name,
                    role=role,
                    password_hash=password_hash,
                )
                session.add(user)
                message = "Created new user"

            await session.commit()
            print(f"{message}: {user.email} ({user.role.value})")
    finally:
        await close_engine()


async def dispatch(args: argparse.Namespace) -> None:
    if args.command == "create-admin":
        await create_admin_user(args)
    else:  # pragma: no cover - argparse prevents reaching this branch
        msg = f"Unknown command: {args.command}"
        raise ValueError(msg)


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    asyncio.run(dispatch(args))


if __name__ == "__main__":
    main()
