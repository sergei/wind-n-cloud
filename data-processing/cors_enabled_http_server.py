#!/usr/bin/env python3

import argparse
import mimetypes
import os
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote


class CorsRangeRequestHandler(SimpleHTTPRequestHandler):
    server_version = "CorsRangeHTTP/1.0"

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header(
            "Access-Control-Expose-Headers",
            "Accept-Ranges, Content-Length, Content-Range",
        )
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_HEAD(self) -> None:
        path = self.translate_path(self.path)

        if not os.path.isfile(path):
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return

        file_size = os.path.getsize(path)
        content_type = self.guess_type(path)

        range_header = self.headers.get("Range")
        byte_range = parse_range_header(range_header, file_size)

        if byte_range is None:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-type", content_type)
            self.send_header("Content-Length", str(file_size))
            self.end_headers()
            return

        start, end = byte_range
        content_length = end - start + 1

        self.send_response(HTTPStatus.PARTIAL_CONTENT)
        self.send_header("Content-type", content_type)
        self.send_header("Content-Length", str(content_length))
        self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        self.end_headers()

    def do_GET(self) -> None:
        path = self.translate_path(self.path)

        if os.path.isdir(path):
            super().do_GET()
            return

        if not os.path.isfile(path):
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return

        file_size = os.path.getsize(path)
        content_type = self.guess_type(path)

        range_header = self.headers.get("Range")
        byte_range = parse_range_header(range_header, file_size)

        if byte_range is None:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-type", content_type)
            self.send_header("Content-Length", str(file_size))
            self.end_headers()

            with open(path, "rb") as file:
                self.copyfile(file, self.wfile)

            return

        start, end = byte_range

        if start >= file_size or end >= file_size or start > end:
            self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            self.send_header("Content-Range", f"bytes */{file_size}")
            self.end_headers()
            return

        content_length = end - start + 1

        self.send_response(HTTPStatus.PARTIAL_CONTENT)
        self.send_header("Content-type", content_type)
        self.send_header("Content-Length", str(content_length))
        self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        self.end_headers()

        with open(path, "rb") as file:
            file.seek(start)
            remaining = content_length
            buffer_size = 1024 * 1024

            while remaining > 0:
                chunk = file.read(min(buffer_size, remaining))
                if not chunk:
                    break

                self.wfile.write(chunk)
                remaining -= len(chunk)

    def translate_path(self, path: str) -> str:
        # Keep SimpleHTTPRequestHandler behavior, but make URL decoding explicit.
        path = unquote(path.split("?", 1)[0].split("#", 1)[0])
        return super().translate_path(path)

    def guess_type(self, path: str) -> str:
        content_type, _ = mimetypes.guess_type(path)

        if content_type:
            return content_type

        if path.lower().endswith(".mp4"):
            return "video/mp4"

        if path.lower().endswith(".json"):
            return "application/json"

        return "application/octet-stream"


def parse_range_header(
    range_header: str | None,
    file_size: int,
) -> tuple[int, int] | None:
    if not range_header:
        return None

    if not range_header.startswith("bytes="):
        return None

    range_value = range_header.removeprefix("bytes=").strip()

    # This simple server supports a single byte range, which is enough for browser video seeking.
    if "," in range_value:
        range_value = range_value.split(",", 1)[0].strip()

    if "-" not in range_value:
        return None

    start_text, end_text = range_value.split("-", 1)

    try:
        if start_text == "":
            # Suffix range, e.g. bytes=-1024
            suffix_length = int(end_text)
            if suffix_length <= 0:
                return None

            start = max(0, file_size - suffix_length)
            end = file_size - 1
            return start, end

        start = int(start_text)

        if end_text == "":
            end = file_size - 1
        else:
            end = int(end_text)

        end = min(end, file_size - 1)

        return start, end
    except ValueError:
        return None


def main() -> None:
    parser = argparse.ArgumentParser(
        fromfile_prefix_chars="@",
        description="Serve files locally with CORS and byte-range support."
    )

    parser.add_argument(
        "--host",
        default="",
        help="Host/interface to bind. Default: all interfaces",
    )

    parser.add_argument(
        "--port",
        type=int,
        default=8000,
        help="Port to serve on. Default: 8000",
    )

    parser.add_argument(
        "--directory",
        type=Path,
        default=Path.cwd(),
        help="Directory to serve. Default: current directory",
    )

    args = parser.parse_args()

    directory = args.directory.expanduser().resolve()

    if not directory.is_dir():
        raise ValueError(f"Directory does not exist: {directory}")

    os.chdir(directory)

    server = ThreadingHTTPServer(
        (args.host, args.port),
        CorsRangeRequestHandler,
    )

    print(f"Serving with CORS and range support at http://localhost:{args.port}")
    print(f"Directory: {directory}")
    print("Press Ctrl+C to stop")

    server.serve_forever()


if __name__ == "__main__":
    main()
