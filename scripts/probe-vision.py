import urllib.request, json, base64, struct, zlib

def png():
    raw = b'\x00\xff\x00\x00'
    def chunk(t, d):
        c = t + d
        return struct.pack('>I', len(d)) + c + struct.pack('>I', zlib.crc32(c))
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw))
            + chunk(b'IEND', b''))

b64 = base64.b64encode(png()).decode()
body = json.dumps({
    'model': 'qwen3.8-flash-next-iq3_s',
    'messages': [{
        'role': 'user',
        'content': [
            {'type': 'text', 'text': 'What color is this image? One word.'},
            {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,' + b64}},
        ],
    }],
    'stream': False,
}).encode()
req = urllib.request.Request(
    'http://127.0.0.1:8080/v1/chat/completions',
    data=body,
    headers={'Content-Type': 'application/json'},
)
d = json.load(urllib.request.urlopen(req, timeout=120))
print('content:', d['choices'][0]['message']['content'][:120])
