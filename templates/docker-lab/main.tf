terraform {
  required_version = ">= 1.6.0"

  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 3.0"
    }
  }
}

# Local lab: the agent talks straight to the Docker socket. No credentials,
# no emulator, no remote API. Override with DOCKER_HOST for a remote daemon.
provider "docker" {
  # host = "unix:///var/run/docker.sock"       # default
  # host = "ssh://user@remote:22"              # remote daemon over SSH
  # host = "tcp://localhost:2375"              # unauthenticated TCP (lab only)
}

variable "project_name" {
  description = "Prefix applied to every lab resource so several labs coexist."
  type        = string
  default     = "iac-lab"
}

variable "web_external_port" {
  description = "Host port published for the nginx container."
  type        = number
  default     = 18080
}

resource "docker_network" "lab" {
  name   = "${var.project_name}-net"
  driver = "bridge"

  labels {
    label = "iac-mode"
    value = "local-lab"
  }
}

# Keep the image explicit: relying on implicit :latest makes plans drift between
# runs even though nothing in the configuration changed.
resource "docker_image" "nginx" {
  name         = "nginx:1.27-alpine"
  keep_locally = true
}

resource "docker_image" "shell" {
  name         = "alpine:3.20"
  keep_locally = true
}

resource "docker_container" "web" {
  name    = "${var.project_name}-web"
  image   = docker_image.nginx.image_id
  restart = "unless-stopped"

  ports {
    internal = 80
    external = var.web_external_port
  }

  networks_advanced {
    name = docker_network.lab.name
  }

  healthcheck {
    test         = ["CMD-SHELL", "wget -qO- http://localhost/ >/dev/null || exit 1"]
    interval     = "10s"
    timeout      = "3s"
    retries      = 3
    start_period = "5s"
  }

  labels {
    label = "iac-mode"
    value = "local-lab"
  }
}

# Dedicated Ansible target: `sleep infinity` keeps it alive for playbook runs.
resource "docker_container" "shell" {
  name    = "${var.project_name}-shell"
  image   = docker_image.shell.image_id
  command = ["sleep", "infinity"]
  restart = "unless-stopped"

  networks_advanced {
    name = docker_network.lab.name
  }

  labels {
    label = "iac-mode"
    value = "local-lab"
  }

  # Ansible's docker connection needs python inside the target.
  provisioner "local-exec" {
    command = "docker exec ${var.project_name}-shell apk add --no-cache python3 || true"
  }
}

output "web_url" {
  description = "Reachable lab endpoint."
  value       = "http://localhost:${var.web_external_port}"
}

output "network_name" {
  value = docker_network.lab.name
}

output "ansible_target" {
  description = "Container name to use as an ansible_connection=docker host."
  value       = docker_container.shell.name
}
