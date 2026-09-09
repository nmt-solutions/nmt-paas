FROM golang:1.27-alpine AS build

WORKDIR /src
COPY apps/node-manager/go.mod apps/node-manager/go.sum ./
RUN go mod download
COPY apps/node-manager ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /node-manager .

FROM alpine:3.22
COPY --from=build /node-manager /usr/local/bin/node-manager
EXPOSE 8080
ENTRYPOINT ["node-manager"]
