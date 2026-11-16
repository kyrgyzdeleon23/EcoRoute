const EcoRouteMap = (() => {
  const defaultCenter = [14.25, 121.15];
  let userMap;
  let hubMap;
  let userPin;
  let userHubMarkers = [];
  let adminHubMarkers = [];

  function popupText(text) {
    return String(text).replace(/[&<>\'"]/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
    }[character]));
  }

  function createMap(elementId) {
    return L.map(elementId).setView(defaultCenter, 9);
  }

  function addTiles(map) {
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);
  }

  function initUserMap(hubs, onPin) {
    if (!userMap) {
      userMap = createMap("userMap");
      addTiles(userMap);
      userMap.on("click", (event) => setUserPin(event.latlng.lat, event.latlng.lng, onPin));
    }
    userHubMarkers.forEach((marker) => marker.remove());
    userHubMarkers = hubs.map((hub) => {
      const marker = L.marker([hub.latitude, hub.longitude])
        .addTo(userMap)
        .bindPopup(`Drop-off: ${popupText(hub.name)}`);
      marker.on("click", () => setUserPin(hub.latitude, hub.longitude, onPin));
      return marker;
    });
  }

  function setUserPin(latitude, longitude, onPin) {
    const point = [latitude, longitude];
    if (!userPin) {
      userPin = L.marker(point, { draggable: true })
        .addTo(userMap)
        .bindPopup("Your pinned location")
        .openPopup();
      userPin.on("dragend", (event) => {
        const position = event.target.getLatLng();
        setUserPin(position.lat, position.lng, onPin);
      });
    } else {
      userPin.setLatLng(point);
    }
    userMap.setView(point, Math.max(userMap.getZoom(), 14));
    onPin(latitude, longitude);
  }

  function centerUserMap() {
    if (!userPin) return false;
    userMap.setView(userPin.getLatLng(), 16);
    userPin.openPopup();
    return true;
  }

  function clearUserPin() {
    if (!userPin) return;
    userPin.remove();
    userPin = null;
  }

  function initAdminMap(hubs, onPin) {
    if (!hubMap) {
      hubMap = createMap("hubMap");
      addTiles(hubMap);
      hubMap.on("click", (event) => onPin(event.latlng.lat, event.latlng.lng));
    }
    adminHubMarkers.forEach((marker) => marker.remove());
    adminHubMarkers = hubs.map((hub) => L.marker([hub.latitude, hub.longitude]).addTo(hubMap).bindPopup(hub.name));
  }

  return { initUserMap, setUserPin, centerUserMap, clearUserPin, initAdminMap };
})();
