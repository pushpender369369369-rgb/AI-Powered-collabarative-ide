export default { server: { proxy: { '/api': 'http://localhost:3000', '/yjs': { target: 'ws://localhost:3000', ws: true } } } };
