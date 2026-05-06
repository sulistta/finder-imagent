import { createLocalServer } from './httpServer.js';

const { server, env } = createLocalServer();

server.listen(env.port, '127.0.0.1', () => {
  console.log(`Localhost Image Finder listening on http://127.0.0.1:${env.port}`);
});
