FROM node:22-alpine

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies (npm ci for reproducible builds; falls back to npm install if lockfile missing)
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

# Generate Prisma client (postinstall runs before schema is copied, so generate explicitly)
RUN npx prisma generate

# Bundle app source
COPY . .

# Generate Prisma client (postinstall runs before schema is copied, so generate explicitly)
RUN npx prisma generate

# Create uploads directory
RUN mkdir -p uploads

# Expose port
EXPOSE 3005

# Start the application
CMD ["npm", "start"]