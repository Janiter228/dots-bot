FROM node:20-alpine

WORKDIR /app

# Копируем только файлы зависимостей для кэширования
COPY package*.json ./
RUN npm ci --only=production

# Копируем исходный код
COPY . .

EXPOSE 4003

# Запускаем сервер
CMD ["node", "server/start.js"]