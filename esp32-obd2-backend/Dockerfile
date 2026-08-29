FROM node:20-alpine

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
COPY package*.json ./

RUN npm install

# Bundle app source
COPY . .

# Create volume for SQLite database persistence
VOLUME ["/usr/src/app/data"]

# Modify server.js to use the volume for database if needed, but since server.js uses ./obd_data.db, 
# we can just map the working directory or change the code slightly.
# Wait, actually, let's just make the volume mount on /usr/src/app where obd_data.db will be created.

EXPOSE 3000
CMD [ "npm", "start" ]
