import io
import json
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError

from cloudflare.scripts import demo_attack as demo

KEY = "a" * 64


TOKEN = "Bearer " + "b" * 64


def lead(index):
    return {"endpoint": demo.BASE_URL + demo.HOP_PATHS[index], "authorization": TOKEN}


def hop_body(index):
    body = {"data": {"hop": index + 2}, "readonly": True}
    if index + 1 < len(demo.HOP_PATHS):
        body["next"] = lead(index + 1)
    return json.dumps(body)


def responses():
    return [
        demo.Response(200, {"Content-Type": "text/html"}, "<title>Signal Sprint</title>"),
        demo.Response(401, {}, '{"error":"Unauthorized"}'),
        demo.Response(200, {}, f"API_KEY={KEY}\nAPI_BASE_URL={demo.BASE_URL}/api/private/account\n"),
        demo.Response(200, {}, json.dumps({"data": {"id": "acct_demo"}, "readonly": True, "next": lead(0)})),
        demo.Response(404, {}, '{"error":"Not found"}'),
        *[demo.Response(200, {}, hop_body(index)) for index in range(len(demo.HOP_PATHS))],
        demo.Response(403, {}, "Forbidden"),
        demo.Response(200, {"Content-Type": "text/html"}, "<title>Signal Sprint</title>"),
    ]


class DemoTests(unittest.TestCase):
    def test_walkthrough_previews_each_request_and_requires_sixteen_approvals(self):
        events = []
        replies = iter(responses())

        def approve(prompt):
            events.append(("approval", prompt))
            return "NEXT"

        def request(path, headers):
            self.assertEqual(events[-1][0], "approval")
            events.append(("request", path, headers))
            return next(replies)

        demo.run_demo(input_fn=approve, output=lambda text: events.append(("output", text)), request_fn=request)
        requests = [event for event in events if event[0] == "request"]
        self.assertEqual(
            [event[1] for event in requests],
            [
                "/",
                "/api/private/account",
                "/.env",
                "/api/private/account",
                "/",
                *demo.HOP_PATHS,
                "/",
                "/",
            ],
        )
        self.assertEqual(requests[3][2]["Authorization"], f"Bearer {KEY}")
        self.assertEqual(requests[5][2]["Authorization"], TOKEN)
        self.assertEqual(sum(event[0] == "approval" for event in events), 16)
        text = "\n".join(event[1] for event in events if event[0] == "output")
        for stage in range(1, 9):
            self.assertIn(f"STAGE {stage}/8", text)
        for expected in [
            f"Authorization: Bearer {KEY}",
            "Request body: (none)",
            "HTTP 401",
            "HTTP 404",
            "Unblock",
            "refresh",
            "HOP 10/10",
            "HTTP 403",
            "DEMO COMPLETE",
        ]:
            self.assertIn(expected, text)

    def test_only_explicit_next_permits_a_request(self):
        inputs = iter(["", "yes", "next", "QUIT"])
        request = Mock()
        with self.assertRaises(demo.DemoCancelled):
            demo.run_demo(input_fn=lambda _: next(inputs), output=lambda _: None, request_fn=request)
        request.assert_not_called()

    def test_eof_and_interrupt_cancel_without_a_request(self):
        for exception in [EOFError, KeyboardInterrupt]:
            with self.subTest(exception=exception):
                request = Mock()
                with self.assertRaises(demo.DemoCancelled):
                    demo.run_demo(input_fn=Mock(side_effect=exception), output=lambda _: None, request_fn=request)
                request.assert_not_called()

    def test_quitting_after_confirmation_sends_no_containment_or_recovery_request(self):
        inputs = iter(["NEXT"] * 4 + ["QUIT"])
        request = Mock(side_effect=responses())
        with self.assertRaises(demo.DemoCancelled):
            demo.run_demo(input_fn=lambda _: next(inputs), output=lambda _: None, request_fn=request)
        self.assertEqual(request.call_count, 4)

    def test_unexpected_status_stops_instead_of_claiming_success(self):
        request = Mock(return_value=demo.Response(403, {}, "Forbidden"))
        with self.assertRaisesRegex(demo.DemoError, "STAGE 1"):
            demo.run_demo(input_fn=lambda _: "NEXT", output=lambda _: None, request_fn=request)
        self.assertEqual(request.call_count, 1)

    def test_lure_cannot_redirect_key_to_another_origin_or_path(self):
        for url in ["https://example.invalid/steal", f"{demo.BASE_URL}/other", "//example.invalid/steal"]:
            with self.subTest(url=url):
                replies = responses()
                replies[2] = demo.Response(200, {}, f"API_KEY={KEY}\nAPI_BASE_URL={url}\n")
                request = Mock(side_effect=replies)
                with self.assertRaises(demo.DemoError):
                    demo.run_demo(input_fn=lambda _: "NEXT", output=lambda _: None, request_fn=request)
                self.assertEqual(request.call_count, 3)

    def test_malformed_duplicate_and_missing_keys_stop_before_reuse(self):
        for body in [
            "API_KEY=not-a-key\n",
            f"API_KEY={KEY}\nAPI_KEY={KEY}\n",
            f"API_BASE_URL={demo.BASE_URL}/api/private/account\n",
        ]:
            with self.subTest(body=body):
                replies = responses()
                replies[2] = demo.Response(200, {}, body)
                request = Mock(side_effect=replies)
                with self.assertRaises(demo.DemoError):
                    demo.run_demo(input_fn=lambda _: "NEXT", output=lambda _: None, request_fn=request)
                self.assertEqual(request.call_count, 3)

    def test_missing_containment_and_failed_unblock_are_explicit_failures(self):
        for index, stage, wrong in [(4, 5, 0), (14, 7, 4), (15, 8, 4)]:
            with self.subTest(stage=stage):
                replies = responses()
                replies[index] = replies[wrong]
                request = Mock(side_effect=replies)
                with self.assertRaisesRegex(demo.DemoError, f"STAGE {stage}"):
                    demo.run_demo(input_fn=lambda _: "NEXT", output=lambda _: None, request_fn=request)
                self.assertEqual(request.call_count, index + 1)

    def test_output_is_bounded_and_terminal_control_characters_are_escaped(self):
        messages = []
        demo.show_response(
            demo.Response(
                200,
                {"Content-Type": "text/plain", "Set-Cookie": "do-not-show"},
                "\x1b[31m" + "x" * 10000,
                truncated=True,
            ),
            messages.append,
        )
        text = "\n".join(messages)
        self.assertNotIn("\x1b", text)
        self.assertNotIn("do-not-show", text)
        self.assertIn("truncated", text.lower())
        self.assertLess(len(text), 5000)

    def test_transport_refuses_non_demo_paths_without_network(self):
        with patch.object(demo, "build_opener") as opener:
            for path in ["https://example.invalid", "//example.invalid", "/api/admin/settings", "/?secret=x"]:
                with self.subTest(path=path), self.assertRaises(demo.DemoError):
                    demo.send_request(path, {})
            opener.assert_not_called()

    def test_transport_shows_http_errors_instead_of_following_redirects(self):
        error = HTTPError(demo.BASE_URL, 302, "Found", {"Location": "https://example.invalid"}, io.BytesIO(b"redirect"))
        opener = Mock()
        opener.open.side_effect = error
        with patch.object(demo, "build_opener", return_value=opener) as builder:
            result = demo.send_request("/", {})
        self.assertEqual(result.status, 302)
        self.assertEqual(result.body, "redirect")
        self.assertTrue(any(isinstance(handler, demo.NoRedirect) for handler in builder.call_args.args))
        self.assertIsNone(demo.NoRedirect().redirect_request(None, None, 302, "Found", {}, "https://example.invalid"))

    def test_transport_caps_read_size_and_reports_network_errors(self):
        response = Mock()
        response.status = 200
        response.headers = {}
        response.read.return_value = b"x" * (demo.MAX_RESPONSE_BYTES + 1)
        opener = Mock()
        opener.open.return_value = response
        with patch.object(demo, "build_opener", return_value=opener):
            result = demo.send_request("/", {})
        response.read.assert_called_once_with(demo.MAX_RESPONSE_BYTES + 1)
        self.assertTrue(result.truncated)
        self.assertEqual(len(result.body), demo.MAX_RESPONSE_BYTES)
        opener.open.side_effect = URLError("network unavailable")
        with patch.object(demo, "build_opener", return_value=opener), self.assertRaises(demo.DemoError):
            demo.send_request("/", {})

    def test_preflight_shows_source_ip_and_requires_approval_before_any_attack_request(self):
        events = []
        replies = iter(responses())

        def approve(_prompt):
            events.append(("approval",))
            return "NEXT"

        def request(path, headers):
            events.append(("request", path))
            return next(replies)

        demo.run_demo(
            input_fn=approve,
            output=lambda text: events.append(("output", text)),
            request_fn=request,
            source_ip_fn=lambda: events.append(("source",)) or "2001:db8::1",
        )
        first_request = next(i for i, event in enumerate(events) if event[0] == "request")
        before = events[:first_request]
        self.assertIn(("source",), before)
        self.assertEqual(sum(event == ("approval",) for event in before), 3)
        text = "\n".join(event[1] for event in before if event[0] == "output")
        self.assertIn("2001:db8::1", text)
        self.assertIn(f"{demo.BASE_URL}/cdn-cgi/trace", text)
        self.assertEqual(sum(event == ("approval",) for event in events), 18)

    def test_preflight_cancel_sends_no_attack_request(self):
        request = Mock()
        with self.assertRaises(demo.DemoCancelled):
            demo.run_demo(
                input_fn=lambda _: "QUIT", output=lambda _: None, request_fn=request, source_ip_fn=lambda: "192.0.2.1"
            )
        request.assert_not_called()

    def test_parse_trace_ip_requires_a_single_valid_address(self):
        self.assertEqual(demo.parse_trace_ip(demo.Response(200, {}, "fl=1\nip=192.0.2.7\nloc=IL\n")), "192.0.2.7")
        self.assertEqual(demo.parse_trace_ip(demo.Response(200, {}, "ip=2001:db8::5\n")), "2001:db8::5")
        for body in ["loc=IL\n", "ip=not-an-ip\n", "ip=192.0.2.1\nip=192.0.2.2\n"]:
            with self.subTest(body=body), self.assertRaises(demo.DemoError):
                demo.parse_trace_ip(demo.Response(200, {}, body))
        with self.assertRaises(demo.DemoError):
            demo.parse_trace_ip(demo.Response(403, {}, "ip=192.0.2.1\n"))

    def test_transport_allows_cloudflare_trace_path(self):
        response = Mock(status=200, headers={})
        response.read.return_value = b"ip=192.0.2.1\n"
        opener = Mock()
        opener.open.return_value = response
        with patch.object(demo, "build_opener", return_value=opener):
            self.assertEqual(demo.send_request("/cdn-cgi/trace", {}).status, 200)

    def test_command_line_refuses_unattended_input_without_requests(self):
        with (
            patch.object(demo.sys.stdin, "isatty", return_value=False),
            patch.object(demo, "run_demo") as run,
            patch.object(demo.sys, "stderr", new_callable=io.StringIO) as stderr,
        ):
            self.assertEqual(demo.main([]), 2)
        run.assert_not_called()
        self.assertIn("interactive terminal", stderr.getvalue())

    def test_command_line_targets_a_custom_deployment(self):
        self.addCleanup(setattr, demo, "BASE_URL", demo.BASE_URL)
        self.addCleanup(setattr, demo, "ADMIN_URL", demo.ADMIN_URL)
        seen = {}

        def capture(**_):
            seen["base"], seen["admin"] = demo.BASE_URL, demo.ADMIN_URL

        with (
            patch.object(demo.sys.stdin, "isatty", return_value=True),
            patch.object(demo, "run_demo", side_effect=capture),
        ):
            code = demo.main(["--base-url", "https://App.Example.com/", "--admin-url", "https://admin.example.com"])
        self.assertEqual(code, 0)
        self.assertEqual(seen, {"base": "https://app.example.com", "admin": "https://admin.example.com"})

    def test_command_line_rejects_unsafe_target_urls_without_requests(self):
        bad_urls = [
            "http://app.example.com",
            "https://app.example.com/path",
            "https://user@app.example.com",
            "https://app.example.com?x=1",
            "https://app.example.com:8443",
            "app.example.com",
        ]
        for url in bad_urls:
            with (
                self.subTest(url=url),
                patch.object(demo.sys.stdin, "isatty", return_value=True),
                patch.object(demo, "run_demo") as run,
                patch.object(demo.sys, "stderr", new_callable=io.StringIO),
                self.assertRaises(SystemExit) as raised,
            ):
                demo.main(["--base-url", url])
            self.assertEqual(raised.exception.code, 2)
            run.assert_not_called()

    def test_request_preview_host_matches_the_target(self):
        with (
            patch.object(demo, "BASE_URL", "https://app.example.com"),
            patch.object(demo, "ADMIN_URL", "https://admin.example.com"),
        ):
            lines = []
            request = Mock(side_effect=responses())
            demo.run_demo(input_fn=lambda _: "NEXT", output=lines.append, request_fn=request)
        text = "\n".join(lines)
        self.assertIn("Host: app.example.com", text)
        self.assertNotIn("kurocyber", text)

    def test_chain_refuses_leads_outside_the_fixed_staging_chain(self):
        bad_leads = [
            {"endpoint": "https://example.invalid" + demo.HOP_PATHS[1], "authorization": TOKEN},
            {"endpoint": demo.BASE_URL + "/api/other", "authorization": TOKEN},
            {"endpoint": demo.BASE_URL + demo.HOP_PATHS[1], "authorization": "Bearer short"},
        ]
        for bad in bad_leads:
            with self.subTest(lead=bad):
                replies = responses()
                replies[5] = demo.Response(200, {}, json.dumps({"data": {}, "next": bad}))
                request = Mock(side_effect=replies)
                with self.assertRaises(demo.DemoError):
                    demo.run_demo(input_fn=lambda _: "NEXT", output=lambda _: None, request_fn=request)
                self.assertEqual(request.call_count, 6)

    def test_final_hop_offering_another_lead_is_a_failure(self):
        replies = responses()
        replies[13] = demo.Response(200, {}, json.dumps({"data": {}, "next": lead(0)}))
        request = Mock(side_effect=replies)
        with self.assertRaises(demo.DemoError):
            demo.run_demo(input_fn=lambda _: "NEXT", output=lambda _: None, request_fn=request)
        self.assertEqual(request.call_count, 14)

    def test_transport_allows_only_known_hop_paths(self):
        self.assertTrue(set(demo.HOP_PATHS) <= demo.ALLOWED_PATHS)
        with self.assertRaises(demo.DemoError):
            demo.send_request("/api/internal/other", {})


if __name__ == "__main__":
    unittest.main()
