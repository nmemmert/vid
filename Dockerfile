FROM node:22-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json server.js push.js ./
COPY public ./public
ENV DATA_DIR=/data PORT=3000 NODE_ENV=production
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD wget -qO- http://127.0.0.1:3000/api/ping || exit 1
CMD ["node", "server.js"]
