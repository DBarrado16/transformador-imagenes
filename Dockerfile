FROM node:22-slim

WORKDIR /app

# Las dependencias primero: asi Docker reutiliza esta capa si solo cambia el codigo
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public

# Dentro del contenedor el 3000 esta libre; el puerto de fuera se decide en compose
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
