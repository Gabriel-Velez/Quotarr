FROM node:22-alpine

ENV HOST=0.0.0.0 \
    PORT=4173 \
    STORAGE_TALLY_DATA_DIR=/data

WORKDIR /app

COPY --chown=node:node package.json server.js lib.js ./
COPY --chown=node:node public ./public

RUN mkdir -p /data && chown node:node /data

USER node

VOLUME ["/data"]
EXPOSE 4173

CMD ["node", "server.js"]
