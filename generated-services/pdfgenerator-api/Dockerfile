FROM ghcr.io/puppeteer/puppeteer:24.16.0

USER root

WORKDIR /app

ENV NODE_ENV=production
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

COPY package.json ./

RUN npm install --omit=dev

COPY --chown=pptruser:pptruser . .

USER pptruser

EXPOSE 3000

CMD ["npm", "start"]
