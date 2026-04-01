# Twilio Bridge Starter

This folder gives you a simple bridge server for the app in this repo.

It exposes:

- `GET /twilio/messages`
- `POST /twilio/send`
- `POST /twilio/incoming`
- `GET /health`

The app uses:

- `Twilio Sync URL` -> `https://your-domain.com/twilio/messages`
- `Twilio Send URL` -> `https://your-domain.com/twilio/send`

Twilio should use:

- `A message comes in` webhook -> `https://your-domain.com/twilio/incoming`

## What it does

- Receives incoming Twilio SMS webhooks
- Stores recent messages in a local JSON file
- Returns those messages to the app
- Sends outbound SMS through Twilio's REST API

## Important note

This is a starter bridge. It is good for early setup and testing, but for production you should move the message store to a real database like Postgres, Supabase, or another durable store.

## Setup

1. Copy `.env.example` to `.env`
2. Fill in your Twilio values
3. Start the bridge:

```bash
node twilio-bridge/server.js
```

4. In Twilio Console, set your phone number's incoming message webhook to:

```text
https://your-domain.com/twilio/incoming
```

5. In the app workspace settings, fill in:

```text
Twilio Line Label: Main business line
Twilio Number: +16025551234
Twilio Sync URL: https://your-domain.com/twilio/messages
Twilio Send URL: https://your-domain.com/twilio/send
Twilio Bridge Key: your-secret
```

## Securing the app-to-bridge calls

If `BRIDGE_KEY` is set, the bridge expects:

```text
Authorization: Bearer your-secret
```

The app now supports a `Twilio Bridge Key` workspace field, so set the same value in both places if you want the bridge locked down.

## Deploy options

- Render
- Railway
- Fly.io
- any small Node server or VM

## Twilio fields you need

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_PHONE_NUMBER`

You can get those from Twilio Console.
