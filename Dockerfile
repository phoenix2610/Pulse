FROM node:26-alpine
RUN apk add --no-cache iputils
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY web ./web
COPY bin ./bin
ENV HOST=0.0.0.0 PORT=4400 PULSE_DATA=/data
VOLUME /data
EXPOSE 4400
HEALTHCHECK CMD wget -qO- http://127.0.0.1:4400/healthz || exit 1
CMD ["node", "bin/pulse.js", "serve"]
