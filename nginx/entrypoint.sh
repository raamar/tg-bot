#!/bin/sh
envsubst '$PUBLIC_DOMAIN' < /etc/nginx/nginx.template.conf > /etc/nginx/nginx.conf
exec nginx -g 'daemon off;'
