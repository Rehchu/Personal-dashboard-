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

A domain in your Cloudflare account: `myfaithtech.com`. The tunnel needs a
hostname to publish, and `*.workers.dev` cannot carry one — DNS records only
exist for real zones.

**Give each camera its own subdomain** — `cam1.myfaithtech.com`,
`cam2.myfaithtech.com` — rather than putting them on paths under a single
hostname. `cloudflared` can match an ingress rule on a path, but it forwards the
original path unchanged; the camera would receive `/cam1/cgi-bin/ptzctrl.cgi`
and answer 404, because nothing strips the prefix. Subdomains need no rewriting.

(The Worker does keep a path prefix if the camera address has one, so a
prefix-stripping reverse proxy at the church would also work. Subdomains are
less to go wrong.)

## The cameras

Three PTZOptics cameras on static LAN IPs, and a fourth coming: a wireless
ground camera an operator carries.

That fourth one has no motor, so add it in the dashboard as **view only** —
answer Cancel when asked whether it pans, tilts and zooms. It then shows its
picture with no pad, no zoom and no presets, because a control that cannot move
a camera is worse than no control at all. If it exposes a snapshot or MJPEG
image over HTTP, give it a tunnel hostname like the others and the live view
works the same way. If it only speaks RTSP or HDMI into the switcher, it belongs
behind go2rtc (see below) rather than here.

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
    cloudflared tunnel route dns church-cams cam1.myfaithtech.com
    cloudflared tunnel route dns church-cams cam2.myfaithtech.com
    cloudflared tunnel route dns church-cams cam3.myfaithtech.com

Then write `config.yml` next to the credentials file:

```yaml
tunnel: church-cams
credentials-file: /path/to/<tunnel-uuid>.json

ingress:
  - hostname: cam1.myfaithtech.com
    service: http://192.168.1.40      # camera 1, its static LAN IP
  - hostname: cam2.myfaithtech.com
    service: http://192.168.1.41      # camera 2
  - hostname: cam3.myfaithtech.com
    service: http://192.168.1.42      # camera 3
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
Access → Applications → add each camera hostname → policy: emails = your address.

Without this, the hostname is as exposed as a port forward would have been. It
is the step that makes the tunnel safer, not the tunnel itself.

## In the dashboard

Church Cameras → **＋ Camera**:

- **Name** — whatever you call it in the room ("Stage", "Balcony")
- **Address** — `https://cam1.myfaithtech.com`, the *tunnel hostname*, never the LAN IP
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

## Seeing the picture

Aiming a camera you cannot see is guesswork, so the module has a live view.

It is not the RTSP stream. No browser plays RTSP, and converting it needs a
transcoder running somewhere. Instead the preview polls the camera's own still
image about once a second, which is enough to frame a shot and is what remote
control actually needs. Press **▸ Live view**.

Models disagree about where that image lives, so the Worker tries the known
paths in turn (`/snapshot.jpg`, `/cgi-bin/snapshot.cgi`, `/tmpfs/auto.jpg`,
`/tmpfs/snap.jpg`) and remembers whichever answered, so later frames go straight
there. A hidden tab stops asking for frames, and four consecutive failures pause
the view rather than hammering a camera that is not there.

### If you want true live video

Run [go2rtc](https://github.com/AlexxIT/go2rtc) or
[MediaMTX](https://github.com/bluenviron/mediamtx) on the same machine as
`cloudflared`. Either takes the camera's RTSP stream and republishes it as
WebRTC (sub-second) or HLS (a few seconds behind). Point a tunnel hostname at
that server instead of at the camera, and embed it in a browser. That is a
bigger install and a second thing to keep running — worth it if you want to
watch the service remotely, unnecessary if you only want to aim the cameras.
