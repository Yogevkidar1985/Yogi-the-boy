FROM node:22-slim

# python for the fast-flights provider bridge — each layer fails loudly so a
# broken provider install can never produce a "successful" image silently
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip pipx \
    && rm -rf /var/lib/apt/lists/*
RUN pip3 install --break-system-packages fast-flights typing_extensions
RUN python3 -c "import fast_flights" # build-time sanity check
RUN pipx install 'flights[mcp]' || true
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm i tsx typescript
COPY . .

EXPOSE 3010
CMD ["npx", "tsx", "src/api/server.ts"]
