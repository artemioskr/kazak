# PHP-FPM с pdo_pgsql — единственное нестандартное расширение, что нам нужно.
FROM php:8.3-fpm-alpine
RUN apk add --no-cache postgresql-dev \
    && docker-php-ext-install pdo_pgsql \
    && apk del --no-cache postgresql-dev \
    && apk add --no-cache libpq
WORKDIR /backend
