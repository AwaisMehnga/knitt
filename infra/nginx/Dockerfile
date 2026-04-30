FROM nginx:alpine

RUN apk add --no-cache openssl

RUN mkdir -p /etc/ssl /tmp/ssl && \
    printf '%s\n' \
      '[req]' \
      'distinguished_name = req_distinguished_name' \
      'x509_extensions = v3_req' \
      'prompt = no' \
      '[req_distinguished_name]' \
      'CN = theoryofautomata.com' \
      '[v3_req]' \
      'subjectAltName = @alt_names' \
      '[alt_names]' \
      'DNS.1 = theoryofautomata.com' \
      'DNS.2 = www.theoryofautomata.com' \
      'DNS.3 = api.theoryofautomata.com' \
      > /tmp/ssl/openssl.cnf && \
    openssl req -x509 -nodes -newkey rsa:2048 \
      -keyout /etc/ssl/privkey.pem \
      -out /etc/ssl/fullchain.pem \
      -days 3650 \
      -config /tmp/ssl/openssl.cnf \
      -extensions v3_req

COPY default.conf /etc/nginx/conf.d/default.conf