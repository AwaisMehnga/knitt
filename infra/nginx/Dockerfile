FROM nginx:alpine

RUN apk add --no-cache openssl

RUN mkdir -p /etc/ssl && \
    openssl req -x509 -nodes -newkey rsa:2048 \
      -keyout /etc/ssl/privkey.pem \
      -out /etc/ssl/fullchain.pem \
      -days 3650 \
      -subj "/CN=theoryofautomata.com"

COPY default.conf /etc/nginx/conf.d/default.conf