FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /data
ENV DB_FILE=/data/attendance.db
EXPOSE 3000
CMD ["node","server.js"]
