from pathlib import Path
import sys

import serverless_wsgi


PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT))

from app import app


def handler(event, context):
    event = dict(event)
    path = event.get("path", "/")
    function_prefix = "/.netlify/functions/api"
    if path.startswith(function_prefix):
        path = path[len(function_prefix):] or "/"
        event["path"] = path if path.startswith("/") else "/" + path
    return serverless_wsgi.handle_request(app, event, context)
