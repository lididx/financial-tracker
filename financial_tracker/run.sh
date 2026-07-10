#!/usr/bin/with-contenv bashio
bashio::log.info "Starting Financial Tracker server..."
cd /app
exec node server/index.js
