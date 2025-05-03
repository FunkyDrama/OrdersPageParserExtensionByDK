document.addEventListener("DOMContentLoaded", function () {
  const btnAddOrder = document.getElementById("getPageSource");
  const btnSaveAll = document.getElementById("saveAll");

  if (btnAddOrder) {
    btnAddOrder.addEventListener("click", addCurrentPageOrder);
  } else {
    console.error("❌ Кнопка 'getPageSource' не найдена!");
  }

  if (btnSaveAll) {
    btnSaveAll.addEventListener("click", saveAllOrders);
  } else {
    console.error("❌ Кнопка 'saveAll' не найдена!");
  }
});

function addCurrentPageOrder() {
  const resultElement = document.getElementById("result");
  if (resultElement) {
    resultElement.innerHTML = "<i>Сбор данных о заказе в процессе</i>";
    resultElement.classList.add("loading");

    let dotCount = 0;
    orderInterval = setInterval(() => {
      dotCount = (dotCount + 1) % 4;
      resultElement.innerHTML =
        "<i>Сбор данных о заказе в процессе</i>" + ".".repeat(dotCount);
    }, 500);

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: collectPageData,
      });
    });
  }
}

function collectPageData() {
  const host = window.location.hostname;
  const pageHTML = document.documentElement.outerHTML;

  const messageObject = {
    action: "content",
    domain: host,
    pageHTML: pageHTML,
  };

  if (host.includes("etsy")) {
    messageObject.links = [];
    try {
      let container = document.getElementById("order-detail-container");

      if (!container) {
        container = document.querySelector(
          ".overflow-y-scroll.height-full.wt-bg-white"
        );
      }

      if (container) {
        const rows = container.querySelectorAll("tbody tr") || [];

        for (let i = 0; i < rows.length; i++) {
          let linkEl = rows[i]?.querySelector("td a");
          if (!linkEl) {
            linkEl = rows[i]?.querySelector(".flag-body a");
          }

          if (linkEl && linkEl.href) {
            if (linkEl.href.includes("/transaction/")) {
              messageObject.links.push(linkEl.href);
            }
          }
        }
      }
    } catch (err) {
      console.log("Etsy: не удалось собрать ссылки:", err);
    }
  } else if (host.includes("wayfair")) {
    const partNumbers = [];
    document.querySelectorAll('tr[data-hb-id="TableRow"]').forEach((row) => {
      const partNumberCell = row.querySelectorAll("td")[1];
      if (partNumberCell) {
        const partNumberElement = partNumberCell.querySelector(
          'p[data-hb-id="Text"]'
        );
        if (partNumberElement) {
          const partNumber = partNumberElement.textContent.trim();
          if (partNumber) {
            partNumbers.push(partNumber);
          }
        }
      }
    });
    console.log("Найдены part numbers:", partNumbers);

    if (partNumbers.length > 0) {
      const inventoryUrl = "https://partners.wayfair.com/d/inventory/overview";
      chrome.runtime.sendMessage({
        action: "processWayfair",
        inventoryUrl,
        partNumbers,
        pageHTML,
      });
    }
  } else if (host.includes("supplieroasis")) {
    const supplierSKUs = [];

    document.querySelectorAll("#lineProductCell").forEach((row) => {
      const skuElement = row.querySelector("div");
      if (skuElement) {
        const sku = skuElement.textContent.trim();
        if (sku) {
          supplierSKUs.push(sku);
        }
      }
    });

    console.log("📦 Найдены SKU:", supplierSKUs);

    if (supplierSKUs.length > 0) {
      const inventoryUrl = "https://edge.supplieroasis.com/product/";
      chrome.runtime.sendMessage({
        action: "processOverstock",
        inventoryUrl,
        supplierSKUs,
        pageHTML,
      });
    }
  } else if (host.includes("ebay")) {
    const buttons = document.querySelectorAll(
      'button.fake-link[aria-label="See more item specifics"]'
    );

    buttons.forEach((btn) => {
      if (btn.getAttribute("aria-expanded") === "false") {
        btn.click();
      }
    });

    const observer = new MutationObserver((mutations, obs) => {
      const stillCollapsed = [
        ...document.querySelectorAll(
          'button.fake-link[aria-label="See more item specifics"]'
        ),
      ].filter((btn) => btn.getAttribute("aria-expanded") === "false");

      if (stillCollapsed.length === 0) {
        const full_html = document.documentElement.outerHTML;

        chrome.runtime.sendMessage({
          action: "content",
          domain: host,
          pageHTML: full_html,
          links: [],
        });

        obs.disconnect();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  chrome.runtime.sendMessage(messageObject);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "content") {
    processPageContent(message);
    return true;
  } else if (message.action === "updatePopup") {
    updatePopup(message.text);
  }
  sendResponse({ success: true });
});

async function processPageContent({ domain, pageHTML, links }) {
  if (!["wayfair", "supplieroasis"].some((site) => domain.includes(site))) {
    let resolvedLinksText = "";
    if (links && links.length > 0) {
      for (const link of links) {
        const finalUrl = await resolveRedirect(link);
        const cleanUrl = finalUrl.split("?")[0];
        resolvedLinksText += cleanUrl + "\n";
      }
    }

    let textBlock = "";
    if (resolvedLinksText) {
      textBlock += resolvedLinksText + "\n";
    }
    textBlock += pageHTML + "\n";

    appendToStorage(textBlock, () => {
      updatePopup("Текущий заказ добавлен!");
    });
  }
}

function saveAllOrders() {
  getAllFromStorage((data) => {
    if (!data) {
      alert("Нет данных для сохранения!");
      return;
    }

    const blob = new Blob([data], { type: "text/plain;charset=utf-8" });
    const fileURL = URL.createObjectURL(blob);
    const element = document.createElement("a");
    element.href = fileURL;
    element.download = "orders.txt";

    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);

    URL.revokeObjectURL(fileURL);

    clearStorage(() => {
      document.getElementById("result").innerText =
        "Все заказы сохранены в orders.txt!";
    });
  });
}

async function resolveRedirect(oldUrl) {
  const response = await chrome.runtime.sendMessage({
    action: "resolveRedirect",
    url: oldUrl,
  });
  return response.finalUrl;
}

function appendToStorage(newText, callback) {
  chrome.storage.local.get("allOrdersData", (result) => {
    const oldData = result.allOrdersData || "";
    const updated = oldData + newText;
    chrome.storage.local.set({ allOrdersData: updated }, () => {
      console.log("Новые данные добавлены в хранилище");
      if (callback) callback();
    });
  });
}

function getAllFromStorage(callback) {
  chrome.storage.local.get("allOrdersData", (result) => {
    callback(result.allOrdersData || "");
  });
}

function clearStorage(callback) {
  chrome.storage.local.set({ allOrdersData: "" }, () => {
    console.log("allOrdersData очищено");
    if (callback) callback();
  });
}

let orderInterval = null;

function updatePopup(text) {
  if (orderInterval) {
    clearInterval(orderInterval);
    orderInterval = null;
  }
  const resultElement = document.getElementById("result");
  if (resultElement) {
    resultElement.classList.remove("loading");
    resultElement.innerText = text;
    setTimeout(() => {
      resultElement.innerText = "Готово к использованию!";
    }, 2000);
  }
}
