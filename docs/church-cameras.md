# Church cameras — reaching them from anywhere

The PTZ module in the dashboard sends commands to a hostname, not to a camera.
This is how that hostname gets wired to the cameras sitting on the church LAN.

## Why not port forwarding

The obvious approach is to forward a port on the church router to each camera
and use the church's public IP. Don't. PTZOptics cameras were built for trusted
networks: the control interface is HTTP with weak default credentials, and
anything scanning the internet for them can drive your cameras and pull your
streams. The public IP is also usually dynamic, so it changes without warning.

A tunnel inverts the direction. A small program on a machine at the church makes
an **outbound** connection to Cloudflare. Nothing connects inward, no router port
is opened, and the church's public IP is irrelevant.

    phone/laptop → Cloudflare → tunnel → machine at church → camera's static LAN IP

That last hop is a normal request from a machine already on the network, which is
why the dashboard only ever needs the **private** address of each camera.

## Prerequisite

A domain in your Cloudflare account. The tunnel needs a hostname to publish, and
`*.workers.dev` cannot carry one — DNS records only exist for real zones. Any
domain works; it does not have to be the church's public site, and a subdomain
nobody advertises is fine.

## What you need on site

- The static LAN IP of each camera (already set)
- Each camera's username and password
- A machine that stays on: the streaming PC, or a Raspberry Pi

## Setup

On the always-on machine at the church:

    # 1. install cloudflared (see Cloudflare's downloads page for your OS)

    # 2. authorise it against your Cloudflare account — opens a browser once
    cloudflared tunnel login

    # 3. create the tunnel; this writes a credentials file and prints its UUID
    cloudflared tunnel create church-cams

    # 4. point hostnames at it, one per camera
    cloudflared tunnel route dns church-cams cam1.example.com
    cloudflared tunnel route dns church-cams cam2.example.com

Then write `config.yml` next to the credentials file:

```yaml
tunnel: church-cams
credentials-file: /path/to/<tunnel-uuid>.json

ingress:
  - hostname: cam1.example.com
    service: http://192.168.1.40      # camera 1, static LAN IP
  - hostname: cam2.example.com
    service: http://192.168.1.41      # camera 2
  # every ingress list must end with a catch-all
  - service: http_status:404
```

Run it, then install it so it survives a reboot:

    cloudflared tunnel run church-cams
    sudo cloudflared service install

## Lock it down

The tunnel makes the cameras reachable, which means reachable by anyone who
learns the hostname. Put **Cloudflare Access** in front of each hostname — a
policy allowing only your email turns an open door into a login. Zero Trust →
Access → Applications → add the hostname → policy: emails = your address.

Without this, the hostname is as exposed as a port forward would have been. It
is the step that makes the tunnel safer, not the tunnel itself.

## In the dashboard

Church Cameras → **＋ Camera**:

- **Name** — whatever you call it in the room ("Stage", "Balcony")
- **Address** — `https://cam1.example.com`, the *tunnel hostname*, never the LAN IP
- **Username / password** — the camera's own credentials

The camera's LAN IP lives only in `config.yml`. The dashboard never sees it, so
nothing has to change when you are away from the building.

Press **⇋ Test** to check the path end to end. Until the tunnel exists, the
module reports that the camera did not answer, which is the expected state.

## How commands travel

The browser cannot reach the LAN, so the dashboard posts to its own Worker, and
the Worker makes the request. That makes the Worker a forwarder, so it is
deliberately narrow: the page names a command from a fixed table
(`up`, `zoomin`, `poscall`, …), and the Worker builds the query string itself.
The path is overwritten with `/cgi-bin/ptzctrl.cgi` no matter what the configured
address contains, redirects are not followed, and speeds and preset numbers are
clamped to the ranges the cameras document. A caller cannot use it to reach an
arbitrary URL.
