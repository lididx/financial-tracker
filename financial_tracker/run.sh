#!/bin/sh
echo "Starting Financial Tracker server..."
cd /app
exec node server/index.js
