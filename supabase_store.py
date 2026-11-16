"""Server-side Supabase clients and Supabase Auth REST helpers."""

import json
import os
from functools import lru_cache
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from dotenv import load_dotenv
from supabase import create_client

load_dotenv()


class SupabaseConfigurationError(RuntimeError):
    """Raised when a required Supabase setting is missing."""


def is_configured():
    return all(os.environ.get(key) for key in (
        "SUPABASE_URL",
        "SUPABASE_ANON_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
    ))


def require_configuration():
    missing = [
        key for key in (
            "SUPABASE_URL",
            "SUPABASE_ANON_KEY",
            "SUPABASE_SERVICE_ROLE_KEY",
        )
        if not os.environ.get(key)
    ]
    if missing:
        raise SupabaseConfigurationError(
            "Supabase is not configured. Set: " + ", ".join(missing)
        )


@lru_cache(maxsize=1)
def database():
    require_configuration()
    return create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_ROLE_KEY"],
    )


def auth_request(endpoint, payload):
    """Call Supabase Auth using the public anon key from the server."""
    require_configuration()
    url = os.environ["SUPABASE_URL"].rstrip("/") + "/auth/v1/" + endpoint
    body = json.dumps(payload).encode("utf-8")
    auth_request_data = Request(
        url,
        data=body,
        headers={
            "apikey": os.environ["SUPABASE_ANON_KEY"],
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urlopen(auth_request_data, timeout=10) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        try:
            details = json.loads(error.read().decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as parse_error:
            raise RuntimeError("Supabase Auth returned an unreadable error") from parse_error
        message = details.get("msg") or details.get("message") or details.get("error_description")
        return error.code, {"error": message or "Supabase Auth rejected the request"}
    except URLError as error:
        raise RuntimeError("Could not connect to Supabase Auth") from error
