//! LAN address selection and validation of untrusted discovery hints.
use crate::protocol::{s, PROTOCOL};
use anyhow::{ensure, Result};
use serde_json::{json, Value};

pub(super) async fn bind_listener(
    address: std::net::Ipv4Addr,
    preferred: Option<u16>,
) -> Result<tokio::net::TcpListener> {
    if let Some(port) = preferred {
        if let Ok(listener) = tokio::net::TcpListener::bind((address, port)).await {
            return Ok(listener);
        }
    }
    Ok(tokio::net::TcpListener::bind((address, 0)).await?)
}

pub(super) fn validate_discovery_hint(hint: &Value) -> Result<Value> {
    ensure!(
        s(hint, "peerProtocol") == PROTOCOL,
        "Unsupported discovery protocol"
    );
    ensure!(
        uuid::Uuid::parse_str(s(hint, "groupId")).is_ok()
            && uuid::Uuid::parse_str(s(hint, "hostDeviceId")).is_ok(),
        "Invalid discovery identity"
    );
    let url = reqwest::Url::parse(s(hint, "baseUrl"))?;
    let base = origin(s(hint, "baseUrl"))?;
    ensure!(
        url.path() == "/" && url.query().is_none() && url.fragment().is_none(),
        "Discovery address must be an origin"
    );
    Ok(
        json!({"groupId":hint["groupId"],"hostDeviceId":hint["hostDeviceId"],"peerProtocol":PROTOCOL,"baseUrl":base,"name":s(hint,"name").chars().take(40).collect::<String>(),"seenAt":chrono::Utc::now().timestamp_millis()}),
    )
}

pub(super) fn local_ipv4_interfaces() -> Result<Vec<(String, std::net::Ipv4Addr)>> {
    Ok(local_ip_address::list_afinet_netifas()?
        .into_iter()
        .filter_map(|(name, ip)| {
            if let std::net::IpAddr::V4(address) = ip {
                Some((name, address))
            } else {
                None
            }
        })
        .collect())
}
pub(super) fn preferred_private_lan_ipv4() -> Result<Option<std::net::Ipv4Addr>> {
    let interfaces = local_ipv4_interfaces()?
        .into_iter()
        .map(|(name, ip)| (name, std::net::IpAddr::V4(ip)))
        .collect::<Vec<_>>();
    Ok(choose_private_lan_ipv4(&interfaces))
}
fn choose_private_lan_ipv4(
    interfaces: &[(String, std::net::IpAddr)],
) -> Option<std::net::Ipv4Addr> {
    let private = interfaces
        .iter()
        .filter(|(_, ip)| matches!(ip,std::net::IpAddr::V4(ip) if ip.is_private()))
        .cloned()
        .collect::<Vec<_>>();
    choose_lan_ip(&private, false).and_then(|ip| {
        if let std::net::IpAddr::V4(ip) = ip {
            Some(ip)
        } else {
            None
        }
    })
}

// The dependency's Android/macOS local_ip() returns the first non-loopback
// interface, which can be a VPN's tun0. Advertise a physical LAN address instead.
pub(super) fn preferred_lan_ip() -> Option<std::net::IpAddr> {
    let interfaces = local_ip_address::list_afinet_netifas().ok()?;
    choose_lan_ip(
        &interfaces,
        cfg!(target_os = "android") || cfg!(target_os = "ios"),
    )
}
fn choose_lan_ip(
    interfaces: &[(String, std::net::IpAddr)],
    mobile: bool,
) -> Option<std::net::IpAddr> {
    interfaces
        .iter()
        .filter_map(|(name, ip)| {
            let std::net::IpAddr::V4(v4) = ip else {
                return None;
            };
            if v4.is_loopback() || v4.is_unspecified() || v4.is_multicast() || v4.is_link_local() {
                return None;
            }
            let name = name.to_ascii_lowercase();
            if [
                "tun",
                "utun",
                "tap",
                "ppp",
                "vmnet",
                "vbox",
                "docker",
                "br-",
                "veth",
                "virbr",
                "bridge",
                "rmnet",
                "pdp_ip",
                "tailscale",
                "wg",
                "zt",
            ]
            .iter()
            .any(|prefix| name.starts_with(prefix))
                || name.contains("vpn")
            {
                return None;
            }
            let wifi = name.starts_with("wlan")
                || name.starts_with("wl")
                || name.contains("wi-fi")
                || name.contains("wifi");
            let ethernet =
                name.starts_with("en") || name.starts_with("eth") || name.contains("ethernet");
            let rank = if wifi {
                if mobile {
                    0
                } else {
                    1
                }
            } else if ethernet {
                if mobile {
                    1
                } else {
                    0
                }
            } else {
                2
            };
            Some((rank, name, *ip))
        })
        .min_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)))
        .map(|(_, _, ip)| ip)
}
pub(super) fn format_peer_url(ip: std::net::IpAddr, port: u16) -> String {
    match ip {
        std::net::IpAddr::V4(ip) => format!("http://{ip}:{port}"),
        std::net::IpAddr::V6(ip) => format!("http://[{ip}]:{port}"),
    }
}

pub(super) fn origin(url: &str) -> Result<String> {
    let u = reqwest::Url::parse(url)?;
    ensure!(
        ["http", "https"].contains(&u.scheme())
            && u.username().is_empty()
            && u.password().is_none()
            && u.host_str().is_some(),
        "Invalid peer URL"
    );
    Ok(u.origin().ascii_serialization())
}
#[cfg(test)]
mod network_tests {
    use super::*;
    #[tokio::test]
    async fn listener_reuses_preferred_port_and_safely_falls_back_on_conflict() {
        let first = bind_listener(std::net::Ipv4Addr::LOCALHOST, None)
            .await
            .unwrap();
        let port = first.local_addr().unwrap().port();
        drop(first);
        let reused = bind_listener(std::net::Ipv4Addr::LOCALHOST, Some(port))
            .await
            .unwrap();
        assert_eq!(reused.local_addr().unwrap().port(), port);
        let fallback = bind_listener(std::net::Ipv4Addr::LOCALHOST, Some(port))
            .await
            .unwrap();
        assert_ne!(fallback.local_addr().unwrap().port(), port);
    }
    fn iface(name: &str, ip: &str) -> (String, std::net::IpAddr) {
        (name.into(), ip.parse().unwrap())
    }
    #[test]
    fn automatic_private_mode_never_selects_a_public_or_virtual_address() {
        let interfaces = vec![
            iface("ens3", "203.0.113.9"),
            iface("docker0", "172.17.0.1"),
            iface("br-a1b2", "172.18.0.1"),
            iface("wg0", "10.0.0.1"),
        ];
        assert!(choose_private_lan_ipv4(&interfaces).is_none());
        let mut private_wifi = interfaces;
        private_wifi.push(iface("wlan0", "192.168.6.2"));
        assert_eq!(
            choose_private_lan_ipv4(&private_wifi).unwrap().to_string(),
            "192.168.6.2"
        );
    }
    #[test]
    fn linux_interface_selection_is_independent_of_host_names_and_ignores_virtual_routes() {
        for physical in ["eth0", "ens42f0", "enp3s0", "wlan0"] {
            let interfaces = vec![
                iface("docker0", "172.17.0.1"),
                iface("wg0", "10.2.0.1"),
                iface(physical, "192.168.8.4"),
            ];
            assert_eq!(
                choose_lan_ip(&interfaces, false).unwrap().to_string(),
                "192.168.8.4"
            );
        }
        let interfaces = vec![iface("docker0", "172.17.0.1"), iface("tun0", "10.2.0.1")];
        assert!(choose_lan_ip(&interfaces, false).is_none());
    }
    #[test]
    fn android_wifi_wins_over_vpn_and_cellular_regardless_of_enumeration_order() {
        let interfaces = vec![
            iface("lo", "127.0.0.1"),
            iface("tun0", "172.19.0.1"),
            iface("rmnet_data2", "5.125.9.237"),
            iface("rmnet_data3", "10.167.157.147"),
            iface("wlan0", "172.29.16.145"),
        ];
        assert_eq!(
            choose_lan_ip(&interfaces, true),
            Some("172.29.16.145".parse().unwrap())
        );
        let mut reversed = interfaces;
        reversed.reverse();
        assert_eq!(
            choose_lan_ip(&reversed, true),
            Some("172.29.16.145".parse().unwrap())
        );
    }
    #[test]
    fn mac_physical_interface_wins_over_virtual_and_invalid_addresses() {
        let interfaces = vec![
            iface("utun2", "172.19.0.1"),
            iface("bridge0", "172.17.0.1"),
            iface("en1", "169.254.1.4"),
            iface("en0", "172.29.5.94"),
        ];
        assert_eq!(
            choose_lan_ip(&interfaces, false),
            Some("172.29.5.94".parse().unwrap())
        );
        assert_eq!(
            choose_lan_ip(
                &[
                    iface("tun0", "172.19.0.1"),
                    iface("rmnet_data2", "5.125.9.237")
                ],
                true
            ),
            None
        );
    }
    #[test]
    fn ipv6_discovery_url_is_bracketed_and_parses() {
        let url = format_peer_url("2001:db8::1".parse().unwrap(), 39607);
        assert_eq!(url, "http://[2001:db8::1]:39607");
        assert_eq!(origin(&url).unwrap(), url);
        assert_eq!(
            format_peer_url("172.29.16.145".parse().unwrap(), 39607),
            "http://172.29.16.145:39607"
        );
    }
}
