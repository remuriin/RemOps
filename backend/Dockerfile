# The backend as a container image. It assumes a Node project where "npm run build" writes dist/
# and "node dist/server.js" starts it on port 3000; change those three if yours differs.
#
# Built on the same kind of CPU it runs on (ARM, see the workflow), so packages with compiled
# code (bcrypt, sharp) get the copy that matches the VPS.

# Step 1: all packages, and the build.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Step 2 is the image that runs: only the packages needed to run, and dist/.
FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# the image's built-in user that is not root
USER node
EXPOSE 3000
# the settings (database, keys) are not in the image: Kubernetes hands them in when the pod starts
CMD ["node", "dist/server.js"]
