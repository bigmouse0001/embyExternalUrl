// @author: chen3861229
// @date: 2024-07-13

import config from "../constant.js";
import util from "../common/util.js";
import events from "../common/events.js";
import emby from "../emby.js";
// import embyApi from "../api/emby-api.js";

async function itemsFilter(r) {
  events.njsOnExit(`itemsFilter: ${r.uri}`);

  r.variables.request_uri += "&Fields=Path";
  // util.appendUrlArg(r.variables.request_uri, "Fields", "Path");
  const subR = await r.subrequest(util.proxyUri(r.uri), {
    method: r.method,
  });
  let body;
  if (subR.status === 200) {
  	body = JSON.parse(subR.responseText);
  } else {
  	r.warn(`itemsFilter subrequest failed, status: ${subR.status}`);
	  return emby.internalRedirect(r);
  }
  const itemHiddenRule = config.itemHiddenRule;
  if (itemHiddenRule && itemHiddenRule.length > 0) {
    r.warn(`itemsFilter before: ${body.Items.length}`);

    const flag = r.variables.flag;
    r.warn(`itemsFilter flag: ${flag}`);
    let mainItemPath;
    if (flag == "itemSimilar") {
      // fetch mount emby/jellyfin file path
      const itemInfo = util.getItemInfo(r);
      r.warn(`itemSimilarInfoUri: ${itemInfo.itemInfoUri}`);
      const embyRes = await util.cost(emby.fetchEmbyFilePath,
        itemInfo.itemInfoUri, 
        itemInfo.itemId, 
        itemInfo.Etag, 
        itemInfo.mediaSourceId
      );
      mainItemPath = embyRes.path;
      r.warn(`mainItemPath: ${mainItemPath}`);
    }

    let itemHiddenCount = 0;
    if (body.Items) {
      body.Items = body.Items.filter(item => {
        if (!item.Path) {
          return true;
        }
        return !itemHiddenRule.some(rule => {
          if ((!rule[2] || rule[2] == 0 || rule[2] == 2) && !!mainItemPath 
            && util.strMatches(rule[0], mainItemPath, rule[1])) {
            return false;
          }
          if (flag == "searchSuggest" && rule[2] == 2) {
            return false;
          }
          if (flag == "backdropSuggest" && rule[2] == 3) {
            return false;
          }
          // 4: 只隐藏[类型风格]接口,这个暂时分页有 bug,被隐藏掉的项会有个空的海报,第一页后的 StartIndex 需要减去 itemHiddenCount
          // 且最重要是无法得知当前浏览项目,会误伤导致接口返回[],不建议实现该功能
          // if (flag == "genreSearch" && rule[2] == 4) {
          //   return false;
          // }
          if (flag == "itemSimilar" && rule[2] == 1) {
            return false;
          }
          if (util.strMatches(rule[0], item.Path, rule[1])) {
            r.warn(`itemPath hit itemHiddenRule: ${item.Path}`);
            itemHiddenCount++;
            return true;
          }
        });
      });
    }
    r.warn(`itemsFilter after: ${body.Items.length}`);
    r.warn(`itemsFilter itemHiddenCount: ${itemHiddenCount}`);
    if (body.TotalRecordCount) {
      body.TotalRecordCount -= itemHiddenCount;
      r.warn(`itemsFilter TotalRecordCount: ${body.TotalRecordCount}`);
    }
  }

  util.copyHeaders(subR.headersOut, r.headersOut);
  return r.return(200, JSON.stringify(body));
}

export default {
  itemsFilter,
};