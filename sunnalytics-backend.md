# Sunnalytics Backend Setup Guide (Render + PostgreSQL)

## ✅ Overview

This guide bootstraps the backend system for **Sunnalytics**, including project setup, API structure, and deployment using **Render**.

---

## 1. 📁 Project Initialization

```bash
mkdir D:\Productivity\Sunnalytics\Web-App\sunnalytics-backend
cd sunnalytics-backend
npm init -y
touch index.ts
```

## 2. 📦 Install Dependencies

```bash
npm install express cors dotenv
npm install -D typescript ts-node nodemon @types/node @types/express prisma
```

## 3. ⚙️ Project Structure

```
sunnalytics-backend/
├── src/
│   ├── index.ts
│   ├── routes/
│   │   ├── memecoin.routes.ts
│   │   ├── defi.routes.ts
│   │   ├── altcoin.routes.ts
│   ├── controllers/
│   ├── services/
│   └── utils/
├── prisma/
│   └── schema.prisma
├── .env
├── tsconfig.json
└── package.json
```

## 4. ⚙️ TypeScript Config

```bash
tsconfig.json
```

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

## 5. ⚙️ Prisma & PostgreSQL Setup

```bash
npx prisma init
```

Edit `.env`:

```
DATABASE_URL="postgresql://your_render_url"
```

Edit `prisma/schema.prisma` example:

```prisma
model Token {
  id        String   @id @default(cuid())
  name      String
  symbol    String
  category  String
  marketCap Float?
  volume24h Float?
  price     Float?
  createdAt DateTime @default(now())
}
```

Then:

```bash
npx prisma db push
```

## 6. 🚀 Start Express Server

`src/index.ts`

```ts
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenv.config();
const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

app.get('/', (_, res) => res.send('Sunnalytics Backend Running'));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
```

## 7. 🔁 Scripts & Nodemon

Edit `package.json`:

```json
"scripts": {
  "dev": "nodemon src/index.ts",
  "build": "tsc",
  "start": "node dist/index.js"
}
```

## 8. 🚀 Deploy to Render

1. Push repo to GitHub
2. Go to [Render](https://render.com)
3. Create new Web Service:

   * Environment: Node
   * Build Command: `npm install && npm run build`
   * Start Command: `npm start`
   * Add environment variable: `DATABASE_URL`
4. Create separate Render PostgreSQL DB and connect it

---

## 🧪 Manual Actions

* [ ] Add full controller logic for token routes
* [ ] Add API validation/middleware
* [ ] Secure public endpoints if necessary

## 📘 Git Setup

```bash
git init
git add .
git commit -m "Initial backend setup"
git remote add origin https://github.com/yourname/sunnalytics-backend.git
git push -u origin main
```

---
