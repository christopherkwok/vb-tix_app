	function SwitchMenu(obj,gametypeid,filterid,ajaxUrl,selclass){
		var ar = document.getElementById("topbuttons").getElementsByTagName("a");
		for (var j=1; j<ar.length+1; j++){
			classexist = document.getElementById("but"+j).className;
			newstr = classexist.replace(selclass, "");
			document.getElementById("but"+j).className = newstr;
		}		
		document.getElementById("but"+obj).className += ' '+selclass;
		jQuery('#loadDiv').show();
		jQuery.ajax({
		type: "POST",
		url: ajaxUrl,
		data: "action=my_open_play_contentbb&buttonid="+obj+"&gametypeid="+gametypeid+"&filterid="+filterid,
		success: function(data){
		if(data != ''){
		jQuery('#loadDiv').hide();
			jQuery('#content-open-play').html(data);
		}	
		}
		});
	}
	$('input').customInput();
		function Validate(frm) {
			var GameID = "0";
			for (var i = 0; i < frm.f_GameID.length; i++) {
				if (frm.f_GameID[i].checked) {
					GameID = frm.f_GameID[i].value;
					break;
				}
			}
			if (GameID == "0") {
				jQuery.fancybox({
					'modal' : true,
					closeClick : true,
					'content' : 'Please Select Your Preferred Slot!<div style="text-align:right;margin-top:10px;">\n\<input style="margin:3px;padding:0px;" type="button" onclick="jQuery.fancybox.close();" value="Ok">\n\</div>'
				});
				return false;
			}
			var waiver = "0";
			var iagree = document.getElementsByName("I_agree");
			if(iagree.length==1){
			if (frm.I_agree.checked) {
					waiver = "1";
				}
	     	}
			if (waiver == "0") {
				jQuery.fancybox({
					'modal' : true,
					closeClick : true,
					'content' : 'Waiver must be checked to continue<div style="text-align:right;margin-top:10px;">\n\<input style="margin:3px;padding:0px;" type="button" onclick="jQuery.fancybox.close();" value="Ok">\n\</div>'
				});
				return false;
			}			
			
			if (trim(frm.f_first_name.value) == "") {
				jQuery.fancybox({
					'modal' : true,
					closeClick : true,
					'content' : 'Please Enter Your First Name !!<div style="text-align:right;margin-top:10px;">\n\<input style="margin:3px;padding:0px;" type="button" onclick="jQuery.fancybox.close();" value="Ok">\n\</div>'
				});
				frm.f_first_name.focus();
				return false;
			}
			if (trim(frm.f_last_name.value) == "") {
				jQuery.fancybox({
					'modal' : true,
					closeClick : true,
					'content' : 'Please Enter Your Last Name !!<div style="text-align:right;margin-top:10px;">\n\<input style="margin:3px;padding:0px;" type="button" onclick="jQuery.fancybox.close();" value="Ok">\n\</div>'
				});
				frm.f_last_name.focus();
				return false;
			}
			if (trim(frm.f_email.value) == "") {
				jQuery.fancybox({
					'modal' : true,
					closeClick : true,
					'content' : 'Please Enter Your Email ID !!<div style="text-align:right;margin-top:10px;">\n\<input style="margin:3px;padding:0px;" type="button" onclick="jQuery.fancybox.close();" value="Ok">\n\</div>'
				});
				frm.f_email.focus();
				return false;
			}
			if (trim(frm.f_cemail.value) == "") {
				jQuery.fancybox({
					'modal' : true,
					closeClick : true,
					'content' : 'Please Enter Confirm Email ID !!<div style="text-align:right;margin-top:10px;">\n\<input style="margin:3px;padding:0px;" type="button" onclick="jQuery.fancybox.close();" value="Ok">\n\</div>'
				});
				frm.f_cemail.focus();
				return false;
			}
			if (!CheckEmail(trim(frm.f_email.value))) {
				frm.f_email.focus();
				return false;
			}
			if (!CheckEmail(trim(frm.f_cemail.value))) {
				frm.f_cemail.focus();
				return false;
			}
			if (trim(frm.f_cemail.value) != trim(frm.f_email.value)) {
				jQuery.fancybox({
					'modal' : true,
					closeClick : true,
					'content' : 'Please Enter Correct Email ID !!<div style="text-align:right;margin-top:10px;">\n\<input style="margin:3px;padding:0px;" type="button" onclick="jQuery.fancybox.close();" value="Ok">\n\</div>'
				});
				frm.f_cemail.focus();
				return false;
			}
			return true;
		}
		function trim(st) {
			if (st.length > 0) {
				re = / +$/g;
				newval = st.replace(re, "")
				re = /^ +/g;
				newvala = newval.replace(re, "")
				return newvala;
			}
			return ""
		}
		function CheckEmail(str) {
		var re = /^(([^<>()[\]\\.,;:\s@\"]+(\.[^<>()[\]\\.,;:\s@\"]+)*)|(\".+\"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
			if (re.test(str)) {
			} else {
				alert("Invalid E-mail ID !!");
				return false;
			}
		
			if ((str.indexOf('@') == -1) || (str.indexOf('.') == -1)) {
				alert("Invalid E-mail ID !!");
				return false;
			}
			if (str.indexOf("%") >= 0 || str.indexOf(">") >= 0 || str.indexOf("/") >= 0 || str.indexOf("\\") >= 0 || str.indexOf("=") >= 0 || str.indexOf("<") >= 0 || str.indexOf("!") >= 0 || str.indexOf("#") >= 0 || str.indexOf("$") >= 0 || str.indexOf("^") >= 0 || str.indexOf("&") >= 0 || str.indexOf("*") >= 0 || str.indexOf("(") >= 0 || str.indexOf(")") >= 0 || str.indexOf("+") >= 0 || str.indexOf("|") >= 0 || str.indexOf("~") >= 0 || str.indexOf("`") >= 0 || str.indexOf(":") >= 0 || str.indexOf(";") >= 0 || str.indexOf("'") >= 0 || str.indexOf(",") >= 0 || str.indexOf('"') >= 0 || str.indexOf("?") >= 0) {
				jQuery.fancybox({
					'modal' : true,
					closeClick : true,
					'content' : 'Special Characters (%,>,/,\\,=,!,#,$,^,&,*,(,),+,|,~,`,:,;,",?,<,\') Are NOT Allowed in Email ID !!<div style="text-align:right;margin-top:10px;">\n\<input style="margin:3px;padding:0px;" type="button" onclick="jQuery.fancybox.close();" value="Ok">\n\</div>'
				});
				return false;
			}
			return true
		}