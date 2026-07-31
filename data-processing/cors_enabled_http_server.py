#!/usr/bin/env python3

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class CorsRequestHandler(SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Expose-Headers", "Accept-Ranges, Content-Length, Content-Range")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.end_headers()


def main() -> None:
    server_address = ("", 8000)
    server = ThreadingHTTPServer(server_address, CorsRequestHandler)

    print("Serving with CORS at http://localhost:8000")
    print("Press Ctrl+C to stop")

    server.serve_forever()


if __name__ == "__main__":
    main()
