import http from 'http';

const PORT = process.env.PORT || 4003;

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', message: 'Dots bot is alive' }));
});

server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});