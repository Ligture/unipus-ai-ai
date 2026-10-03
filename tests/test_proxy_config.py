"""Verify proxy routing without loading Whisper or starting the API server."""
import ast
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock


class ProxyConfigTests(unittest.TestCase):
    def routing(self, config):
        source = ast.parse((Path(__file__).resolve().parents[1] / 'api.py').read_text(encoding='utf-8'))
        names = {'is_proxy_enabled', 'create_http_client', 'get_requests_proxies'}
        functions = [node for node in source.body
                     if isinstance(node, ast.FunctionDef) and node.name in names]
        client = Mock()
        context = {'proxy_config': config, 'logger': Mock(), 'httpx': SimpleNamespace(Client=client)}
        exec(compile(ast.Module(body=functions, type_ignores=[]), 'api.py', 'exec'), context)
        context['create_http_client']()
        return client.call_args.kwargs, context['get_requests_proxies']()

    def test_independent_switches_override_legacy_value(self):
        for legacy in (True, False):
            for llm in (True, False):
                for media in (True, False):
                    with self.subTest(legacy=legacy, llm=llm, media=media):
                        client, proxies = self.routing({
                            'enabled': legacy, 'llm_enabled': llm, 'media_enabled': media,
                            'http': 'http://localhost:8001', 'https': 'http://localhost:8002'})
                        self.assertEqual(client, {'proxy': 'http://localhost:8002' if llm else None,
                                                  'trust_env': False})
                        self.assertEqual(proxies, {
                            'http': 'http://localhost:8001' if media else None,
                            'https': 'http://localhost:8002' if media else None})

    def test_legacy_config_and_defaults(self):
        for enabled in (True, False):
            client, proxies = self.routing({'enabled': enabled, 'http': 'http://localhost:8001'})
            self.assertEqual(client['proxy'], 'http://localhost:8001' if enabled else None)
            self.assertEqual(proxies['http'], 'http://localhost:8001' if enabled else None)
        self.assertEqual(self.routing({}),
                         ({'proxy': None, 'trust_env': False}, {'http': None, 'https': None}))

    def test_single_override_preserves_other_legacy_switch(self):
        client, proxies = self.routing({'enabled': True, 'media_enabled': False,
                                        'https': 'http://localhost:8002'})
        self.assertEqual(client['proxy'], 'http://localhost:8002')
        self.assertEqual(proxies, {'http': None, 'https': None})


if __name__ == '__main__':
    unittest.main()
